import {
  isPoolableDriver,
  PROVIDER_DISPLAY_NAMES,
  providerLimitedUntilMs,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderPoolConfig,
  type ProviderPoolSettings,
  type ProviderPoolSettingsPatch,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";

import type { TimestampFormat } from "@t3tools/contracts/settings";

import { formatUpcomingTimestamp } from "../../timestampFormat";
import { getProviderSummary } from "./providerStatus";

export function limitedUntilLabel(
  provider: Pick<ServerProvider, "limitedUntil">,
  nowMs: number,
  timestampFormat: TimestampFormat,
): string | null {
  if (provider.limitedUntil === undefined || providerLimitedUntilMs(provider, nowMs) === null) {
    return null;
  }
  return `Limited until ${formatUpcomingTimestamp(provider.limitedUntil, timestampFormat, nowMs)}`;
}

export function resolveProviderPoolName(
  providers: ReadonlyArray<ServerProvider>,
  provider: Pick<ServerProvider, "pool"> | undefined,
): string | undefined {
  if (provider?.pool?.role !== "member") return undefined;
  const { poolInstanceId } = provider.pool;
  const pool = providers.find((candidate) => candidate.instanceId === poolInstanceId);
  return pool === undefined ? undefined : resolveProviderInstanceDisplayName(pool);
}

/**
 * Accounts sharing a continuation group resume each other's conversations natively; any other
 * switch is a summary handoff, which is what makes a third-party endpoint visibly different.
 */
function continuationHint(
  provider: ServerProvider,
  siblings: ReadonlyArray<ServerProvider>,
): string | null {
  const groupKey = provider.continuation?.groupKey;
  if (groupKey === undefined) return null;
  const sharing = siblings.filter(
    (candidate) =>
      candidate.instanceId !== provider.instanceId && candidate.continuation?.groupKey === groupKey,
  );
  if (sharing.length > 0) {
    return `Continues the same conversations as ${sharing.map(resolveProviderInstanceDisplayName).join(", ")}`;
  }
  return siblings.some((candidate) => candidate.continuation?.groupKey !== undefined)
    ? "Own conversation history, so switching to or from it uses a summary"
    : null;
}

/** Two instances signed in as one login share a single quota, so pooling them adds no capacity. */
function sameLoginHint(
  provider: ServerProvider,
  siblings: ReadonlyArray<ServerProvider>,
): string | null {
  const email = provider.auth.email?.trim().toLowerCase();
  if (!email) return null;
  const sharing = siblings.filter(
    (candidate) =>
      candidate.instanceId !== provider.instanceId &&
      candidate.auth.email?.trim().toLowerCase() === email,
  );
  return sharing.length > 0
    ? `Same login as ${sharing.map(resolveProviderInstanceDisplayName).join(", ")}`
    : null;
}

export interface ProviderPoolCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly status: string;
  readonly ticked: boolean;
  readonly continuationHint: string | null;
  readonly sameLoginHint: string | null;
  readonly provider: ServerProvider;
}

export interface ProviderPoolCard {
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly candidates: ReadonlyArray<ProviderPoolCandidate>;
  readonly enabled: boolean;
  readonly canEnable: boolean;
  readonly modelCoverage: { readonly available: number; readonly total: number } | null;
}

export function buildProviderPoolCards(
  providers: ReadonlyArray<ServerProvider>,
  providerPools: ProviderPoolSettings,
): ReadonlyArray<ProviderPoolCard> {
  const accounts = providers.filter((provider) => provider.pool?.role !== "pool");
  const drivers = [...new Set(accounts.map((provider) => provider.driver))].filter(
    isPoolableDriver,
  );
  return drivers.flatMap((driver) => {
    const siblings = accounts.filter((provider) => provider.driver === driver);
    if (siblings.length < 2) return [];
    const config = providerPools[driver];
    const ticked = new Set(config?.memberInstanceIds);
    const pool = providers.find(
      (provider) => provider.driver === driver && provider.pool?.role === "pool",
    );
    return [
      {
        driver,
        label: PROVIDER_DISPLAY_NAMES[driver] ?? driver,
        candidates: siblings.map((provider) => ({
          instanceId: provider.instanceId,
          displayName: resolveProviderInstanceDisplayName(provider),
          status: getProviderSummary(provider).headline,
          ticked: ticked.has(provider.instanceId),
          continuationHint: continuationHint(provider, siblings),
          sameLoginHint: sameLoginHint(provider, siblings),
          provider,
        })),
        enabled: config?.enabled ?? false,
        canEnable: siblings.filter((provider) => ticked.has(provider.instanceId)).length >= 2,
        modelCoverage:
          pool?.pool?.role === "pool"
            ? {
                available: pool.models.length,
                total: pool.models.length + pool.pool.droppedModels.length,
              }
            : null,
      },
    ];
  });
}

export function modelCoverageLabel(coverage: { available: number; total: number }): string {
  return coverage.available === coverage.total
    ? `All ${coverage.total} models are available with the same options in every ticked account`
    : `${coverage.available} of ${coverage.total} models are available with the same options in every ticked account`;
}

export type ProviderPoolChange =
  | { readonly type: "tick"; readonly instanceId: ProviderInstanceId; readonly ticked: boolean }
  | { readonly type: "enabled"; readonly enabled: boolean };

export function buildProviderPoolPatch(
  driver: ProviderDriverKind,
  current: ProviderPoolConfig | undefined,
  change: ProviderPoolChange,
): ProviderPoolSettingsPatch {
  const memberInstanceIds = current?.memberInstanceIds ?? [];
  if (change.type === "enabled") {
    return { [driver]: { enabled: change.enabled, memberInstanceIds } };
  }
  const others = memberInstanceIds.filter((instanceId) => instanceId !== change.instanceId);
  const nextMembers = change.ticked ? [...others, change.instanceId] : others;
  return {
    [driver]:
      nextMembers.length === 0
        ? null
        : { enabled: current?.enabled ?? false, memberInstanceIds: nextMembers },
  };
}
