import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  isProviderDriverKind,
  ProviderDriverKind,
  ProviderInstanceId,
} from "./providerInstance.ts";
import type { ServerProvider } from "./server.ts";

export const ProviderPoolConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Ordered: the order breaks routing ties and picks the pool's model metadata.
  memberInstanceIds: Schema.Array(ProviderInstanceId),
});
export type ProviderPoolConfig = typeof ProviderPoolConfig.Type;

export const ProviderPoolSettings = Schema.Record(ProviderDriverKind, ProviderPoolConfig);
export type ProviderPoolSettings = typeof ProviderPoolSettings.Type;

export const ProviderPoolSettingsPatch = Schema.Record(
  ProviderDriverKind,
  Schema.NullOr(ProviderPoolConfig),
);
export type ProviderPoolSettingsPatch = typeof ProviderPoolSettingsPatch.Type;

export const ServerProviderPool = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("pool"),
    memberInstanceIds: Schema.Array(ProviderInstanceId),
    // Slugs some member lacks, left out of the pool's intersected models.
    droppedModels: Schema.Array(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    role: Schema.Literal("member"),
    poolInstanceId: ProviderInstanceId,
  }),
]);
export type ServerProviderPool = typeof ServerProviderPool.Type;

const PROVIDER_POOL_ID_PREFIX = "pool_";

export const providerPoolInstanceId = (driver: ProviderDriverKind): ProviderInstanceId =>
  ProviderInstanceId.make(`${PROVIDER_POOL_ID_PREFIX}${driver}`);

export const isReservedProviderInstanceId = (instanceId: string): boolean =>
  instanceId.startsWith(PROVIDER_POOL_ID_PREFIX);

/**
 * Only drivers whose instances are accounts of one service pool. ACP registry
 * instances are different agents, and the other drivers' usage-limit and
 * handoff behavior has not been checked.
 */
const POOLABLE_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set([
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
]);

export const isPoolableDriver = (driver: ProviderDriverKind): boolean =>
  POOLABLE_DRIVERS.has(driver);

export const providerPoolDriver = (instanceId: ProviderInstanceId): ProviderDriverKind | null => {
  if (!isReservedProviderInstanceId(instanceId)) return null;
  const driver = instanceId.slice(PROVIDER_POOL_ID_PREFIX.length);
  return isProviderDriverKind(driver) ? driver : null;
};

export interface ActiveProviderPool {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly memberInstanceIds: ReadonlyArray<ProviderInstanceId>;
}

/**
 * Settings may name instances that were removed or never matched the driver;
 * those are ignored here rather than rejected, so a stale entry only shrinks
 * the pool.
 */
export function resolveActiveProviderPools(input: {
  readonly providerPools: ProviderPoolSettings;
  readonly instances: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "enabled">>;
}): ReadonlyArray<ActiveProviderPool> {
  return Object.entries(input.providerPools).flatMap(([key, config]) => {
    const driver = ProviderDriverKind.make(key);
    if (!config.enabled || !isPoolableDriver(driver)) return [];
    const memberInstanceIds = [...new Set(config.memberInstanceIds)].filter((memberId) =>
      input.instances.some(
        (instance) =>
          instance.instanceId === memberId && instance.driver === driver && instance.enabled,
      ),
    );
    return memberInstanceIds.length >= 2
      ? [{ driver, instanceId: providerPoolInstanceId(driver), memberInstanceIds }]
      : [];
  });
}

/** Finds the pool by its own id or by any member id. Members come in pool order. */
export function findProviderPool(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): { readonly pool: ServerProvider; readonly members: ReadonlyArray<ServerProvider> } | null {
  const entry = providers.find((provider) => provider.instanceId === instanceId);
  const poolInstanceId =
    entry?.pool?.role === "member" ? entry.pool.poolInstanceId : entry?.instanceId;
  const pool = providers.find((provider) => provider.instanceId === poolInstanceId);
  if (pool?.pool?.role !== "pool") return null;
  const members = pool.pool.memberInstanceIds.flatMap((memberId) =>
    providers.filter((provider) => provider.instanceId === memberId),
  );
  return { pool, members };
}

export function providerLimitedUntilMs(
  provider: Pick<ServerProvider, "limitedUntil">,
  nowMs: number,
): number | null {
  if (provider.limitedUntil === undefined) return null;
  const untilMs = Date.parse(provider.limitedUntil);
  return untilMs > nowMs ? untilMs : null;
}
