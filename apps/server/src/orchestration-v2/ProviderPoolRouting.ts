import {
  defaultInstanceIdForDriver,
  findProviderPool,
  isProviderAvailable,
  providerLimitedUntilMs,
  providerPoolDriver,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";

/** What routing knows about one member. Derived per call, never stored. */
export interface PoolMemberHealth {
  readonly instanceId: ProviderInstanceId;
  /** Enabled for the project, installed, signed in, not erroring, available. */
  readonly eligible: boolean;
  /** Shared with every member on the same credential fingerprint: one login is one quota. */
  readonly limitedUntilMs: number | null;
  readonly continuationKey: string | null;
}

export interface PoolRoutingInput {
  /** Pool order; it breaks every tie. */
  readonly members: ReadonlyArray<PoolMemberHealth>;
  readonly threadId: ThreadId;
  /** The thread's current instance, null for a new thread. */
  readonly current: {
    readonly instanceId: ProviderInstanceId;
    /** A run is active on it: steering and queueing never move a live turn. */
    readonly busy: boolean;
  } | null;
  /** Members that already failed this run. */
  readonly excluded: ReadonlySet<ProviderInstanceId>;
  readonly nowMs: number;
}

export type PoolRoutingDecision =
  | {
      readonly type: "member";
      readonly instanceId: ProviderInstanceId;
      readonly reason: "busy" | "affinity" | "same_continuation" | "spread";
    }
  /**
   * Every eligible member is cooling. The turn still goes to one of them so
   * today's limit banner and auto-resume run, with the pool's earliest reset.
   */
  | {
      readonly type: "all_limited";
      readonly instanceId: ProviderInstanceId;
      readonly earliestResetAtMs: number;
    }
  | { readonly type: "no_eligible_member" };

/** FNV-1a, 32-bit, over `${threadId}\u0000${instanceId}`. */
export function rendezvousScore(threadId: ThreadId, instanceId: ProviderInstanceId): number {
  const text = `${threadId}\u0000${instanceId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const isCooling = (member: PoolMemberHealth, nowMs: number): boolean =>
  member.limitedUntilMs !== null && member.limitedUntilMs > nowMs;

/**
 * Ranking, first match wins: the current member while a run is live on it,
 * the current member while healthy, a healthy member sharing the current
 * member's continuation key (Codex accounts on one home resume natively),
 * then the healthy member with the highest rendezvous score. Rendezvous
 * hashing spreads new threads with no cursor to persist, and a member that
 * cools moves only its own threads.
 */
export function choosePoolMember(input: PoolRoutingInput): PoolRoutingDecision {
  const candidates = input.members.filter(
    (member) => member.eligible && !input.excluded.has(member.instanceId),
  );
  const current = candidates.find((member) => member.instanceId === input.current?.instanceId);
  if (current !== undefined && input.current?.busy) {
    return { type: "member", instanceId: current.instanceId, reason: "busy" };
  }
  const healthy = candidates.filter((member) => !isCooling(member, input.nowMs));
  if (current !== undefined && !isCooling(current, input.nowMs)) {
    return { type: "member", instanceId: current.instanceId, reason: "affinity" };
  }
  const sibling =
    current?.continuationKey === null || current === undefined
      ? undefined
      : healthy.find((member) => member.continuationKey === current.continuationKey);
  if (sibling !== undefined) {
    return { type: "member", instanceId: sibling.instanceId, reason: "same_continuation" };
  }
  const spread = healthy.reduce<PoolMemberHealth | undefined>(
    (best, member) =>
      best === undefined ||
      rendezvousScore(input.threadId, member.instanceId) >
        rendezvousScore(input.threadId, best.instanceId)
        ? member
        : best,
    undefined,
  );
  if (spread !== undefined) {
    return { type: "member", instanceId: spread.instanceId, reason: "spread" };
  }
  const earliest = candidates.reduce<PoolMemberHealth | undefined>(
    (best, member) =>
      best === undefined || (member.limitedUntilMs ?? 0) < (best.limitedUntilMs ?? 0)
        ? member
        : best,
    undefined,
  );
  if (earliest === undefined) {
    return { type: "no_eligible_member" };
  }
  return {
    type: "all_limited",
    instanceId: current?.instanceId ?? earliest.instanceId,
    earliestResetAtMs: earliest.limitedUntilMs ?? input.nowMs,
  };
}

/** Earliest moment any eligible member is usable again; null while one already is. */
export function earliestPoolResetAtMs(
  members: ReadonlyArray<PoolMemberHealth>,
  nowMs: number,
): number | null {
  const eligible = members.filter((member) => member.eligible);
  if (eligible.length === 0 || eligible.some((member) => !isCooling(member, nowMs))) return null;
  return Math.min(...eligible.map((member) => member.limitedUntilMs ?? nowMs));
}

const isMemberHealthy = (provider: ServerProvider): boolean =>
  provider.enabled &&
  provider.installed &&
  isProviderAvailable(provider) &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.auth.status !== "unauthenticated";

export function poolMemberHealth(input: {
  readonly members: ReadonlyArray<ServerProvider>;
  readonly settings: Parameters<typeof resolveProjectProviderInstanceEnabled>[0];
  readonly projectId: ProjectId;
  readonly nowMs: number;
}): ReadonlyArray<PoolMemberHealth> {
  const limitedUntilOf = (member: ServerProvider): number | null => {
    const fingerprint = member.usageLimits?.credentialFingerprint;
    const sharing =
      fingerprint === undefined
        ? [member]
        : input.members.filter(
            (candidate) => candidate.usageLimits?.credentialFingerprint === fingerprint,
          );
    return sharing.reduce<number | null>((latest, candidate) => {
      const untilMs = providerLimitedUntilMs(candidate, input.nowMs);
      return untilMs === null || (latest !== null && latest >= untilMs) ? latest : untilMs;
    }, null);
  };
  return input.members.map((member) => ({
    instanceId: member.instanceId,
    eligible:
      isMemberHealthy(member) &&
      resolveProjectProviderInstanceEnabled(input.settings, input.projectId, member.instanceId),
    limitedUntilMs: limitedUntilOf(member),
    continuationKey: member.continuation?.groupKey ?? null,
  }));
}

export type RoutedSelection =
  /** Names no pool and no pooled account: returned by reference. */
  | { readonly type: "unrouted"; readonly selection: ModelSelection }
  | {
      readonly type: "routed";
      /** `instanceId` is always a concrete member. */
      readonly selection: ModelSelection;
      readonly pool: ServerProvider;
      readonly decision: Exclude<PoolRoutingDecision, { readonly type: "no_eligible_member" }>;
    }
  | { readonly type: "no_eligible_member"; readonly pool: ServerProvider };

/**
 * The one routing entry for every place a selection enters a thread. A
 * selection naming a pool or any of its members routes: pooling an account
 * declares it interchangeable. A dangling pool id (pool off or deleted)
 * resolves to the thread's current same-driver instance, else the driver's
 * default, so drafts and scheduled tasks never strand.
 */
export function routeModelSelection(input: {
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Parameters<typeof resolveProjectProviderInstanceEnabled>[0];
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly current: PoolRoutingInput["current"];
  readonly excluded?: ReadonlySet<ProviderInstanceId>;
  readonly nowMs: number;
}): RoutedSelection {
  const owner = findProviderPool(input.providers, input.selection.instanceId);
  if (owner === null) {
    const driver = providerPoolDriver(input.selection.instanceId);
    if (driver === null) return { type: "unrouted", selection: input.selection };
    const currentProvider = input.providers.find(
      (provider) => provider.instanceId === input.current?.instanceId,
    );
    const instanceId =
      currentProvider?.driver === driver
        ? currentProvider.instanceId
        : defaultInstanceIdForDriver(driver);
    return { type: "unrouted", selection: { ...input.selection, instanceId } };
  }
  const decision = choosePoolMember({
    members: poolMemberHealth({
      members: owner.members,
      settings: input.settings,
      projectId: input.projectId,
      nowMs: input.nowMs,
    }),
    threadId: input.threadId,
    current: input.current,
    excluded: input.excluded ?? new Set(),
    nowMs: input.nowMs,
  });
  if (decision.type === "no_eligible_member") {
    return { type: "no_eligible_member", pool: owner.pool };
  }
  return {
    type: "routed",
    selection: { ...input.selection, instanceId: decision.instanceId },
    pool: owner.pool,
    decision,
  };
}
