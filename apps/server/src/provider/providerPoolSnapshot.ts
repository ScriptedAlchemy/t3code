import {
  PROVIDER_DISPLAY_NAMES,
  resolveActiveProviderPools,
  type ActiveProviderPool,
  type ProviderPoolSettings,
  type ServerProvider,
} from "@t3tools/contracts";

const STATUS_RANK: Record<ServerProvider["status"], number> = {
  ready: 0,
  warning: 1,
  error: 2,
  disabled: 3,
};
const AUTH_RANK: Record<ServerProvider["auth"]["status"], number> = {
  authenticated: 0,
  unknown: 1,
  unauthenticated: 2,
};

const healthRank = (provider: ServerProvider): number =>
  (provider.installed ? 0 : 100) +
  STATUS_RANK[provider.status] * 10 +
  AUTH_RANK[provider.auth.status];

/** Pool order breaks ties, so the first member wins when health is equal. */
const healthiestMember = (members: ReadonlyArray<ServerProvider>): ServerProvider =>
  members.reduce((best, candidate) =>
    healthRank(candidate) < healthRank(best) ? candidate : best,
  );

const intersectByName = <Entry extends { readonly name: string }>(
  lists: ReadonlyArray<ReadonlyArray<Entry>>,
): ReadonlyArray<Entry> => {
  const [first, ...rest] = lists;
  if (first === undefined) return [];
  return first.filter((entry) =>
    rest.every((list) => list.some((candidate) => candidate.name === entry.name)),
  );
};

function makePoolEntry(
  pool: ActiveProviderPool,
  first: ServerProvider,
  members: ReadonlyArray<ServerProvider>,
): ServerProvider {
  const healthiest = healthiestMember(members);
  const slugCounts = new Map<string, number>();
  for (const member of members) {
    for (const slug of new Set(member.models.map((model) => model.slug))) {
      slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
    }
  }
  const sharedSlugs = new Set(
    [...slugCounts].filter(([, count]) => count === members.length).map(([slug]) => slug),
  );
  // Metadata comes from the first member in pool order that advertises the slug.
  const models = members
    .flatMap((member) => member.models)
    .filter((model, index, all) => {
      if (!sharedSlugs.has(model.slug)) return false;
      return all.findIndex((candidate) => candidate.slug === model.slug) === index;
    });
  const groupKeys = new Set(members.map((member) => member.continuation?.groupKey ?? null));
  const sharedGroupKey = groupKeys.size === 1 ? (first.continuation?.groupKey ?? null) : null;
  return {
    instanceId: pool.instanceId,
    driver: pool.driver,
    displayName: PROVIDER_DISPLAY_NAMES[pool.driver] ?? pool.driver,
    badgeLabel: "Pool",
    ...(sharedGroupKey === null ? {} : { continuation: { groupKey: sharedGroupKey } }),
    ...(first.showInteractionModeToggle === undefined
      ? {}
      : { showInteractionModeToggle: first.showInteractionModeToggle }),
    ...(first.reportsContextWindow === undefined
      ? {}
      : { reportsContextWindow: first.reportsContextWindow }),
    ...(first.supportedRuntimeModes === undefined
      ? {}
      : { supportedRuntimeModes: first.supportedRuntimeModes }),
    ...(first.requiresNewThreadForModelChange === undefined
      ? {}
      : { requiresNewThreadForModelChange: first.requiresNewThreadForModelChange }),
    ...(first.supportsConversationRollback === undefined
      ? {}
      : { supportsConversationRollback: first.supportsConversationRollback }),
    // Text generation and source-control writers call adapters directly, which a
    // pool cannot answer; keeping it false hides the pool from those pickers.
    supportsTextGeneration: false,
    enabled: true,
    installed: healthiest.installed,
    version: healthiest.version,
    status: healthiest.status,
    auth: healthiest.auth,
    checkedAt: healthiest.checkedAt,
    models,
    slashCommands: intersectByName(members.map((member) => member.slashCommands)),
    skills: intersectByName(members.map((member) => member.skills)),
    pool: {
      role: "pool",
      memberInstanceIds: pool.memberInstanceIds,
      droppedModels: [...slugCounts.keys()].filter((slug) => !sharedSlugs.has(slug)),
    },
  };
}

/**
 * The published provider list: every real instance, plus one virtual entry per
 * active pool, with each member stamped as belonging to it. Pools need two
 * enabled, existing members of the driver; anything less publishes nothing
 * and stamps nothing, so a pool never half-exists.
 */
export function withProviderPools(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerPools: ProviderPoolSettings;
}): ReadonlyArray<ServerProvider> {
  const pools = resolveActiveProviderPools({
    providerPools: input.providerPools,
    instances: input.providers,
  });
  if (pools.length === 0) return input.providers;
  const poolByMember = new Map(
    pools.flatMap((pool) =>
      pool.memberInstanceIds.map((memberId) => [memberId, pool.instanceId] as const),
    ),
  );
  const byId = new Map(input.providers.map((provider) => [provider.instanceId, provider]));
  return [
    ...input.providers.map((provider) => {
      const poolInstanceId = poolByMember.get(provider.instanceId);
      return poolInstanceId === undefined
        ? provider
        : { ...provider, pool: { role: "member" as const, poolInstanceId } };
    }),
    ...pools.flatMap((pool) => {
      const members = pool.memberInstanceIds.flatMap((memberId) => {
        const member = byId.get(memberId);
        return member === undefined ? [] : [member];
      });
      const [first] = members;
      return first === undefined ? [] : [makePoolEntry(pool, first, members)];
    }),
  ];
}
