import { providerLimitedUntilMs, type ServerProvider } from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";

import type { TimestampFormat } from "@t3tools/contracts/settings";

import { formatUpcomingTimestamp } from "../../timestampFormat";

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
