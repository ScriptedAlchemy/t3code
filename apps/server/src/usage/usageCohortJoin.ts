import type {
  UsageCohortReport,
  UsageCohortSegment,
  UsageCohortUnmatched,
  UsageProviderKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { UsageRecord, UsageSpeed } from "@t3tools/provider-core/server/usage";

import type { PricedUsage } from "./usageAggregation.ts";

export type UsageOrigin = "user" | "agent" | "server_dispatched" | "scheduled";

export interface AttemptStamp {
  readonly origin: UsageOrigin;
  readonly t3Version: string;
  readonly settings: Readonly<Record<string, boolean>>;
}

/** An attempt as the projection knows it, with the stamp left-joined; a null stamp means "before tracking". */
export interface AttemptRow {
  readonly attemptId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly providerInstanceId: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly stamp: AttemptStamp | null;
}

export type UnmatchedReason = UsageCohortUnmatched["reason"];

export type Attribution =
  | { readonly _tag: "child_work" }
  | { readonly _tag: "attempt"; readonly attempt: AttemptRow }
  | { readonly _tag: "unmatched"; readonly reason: UnmatchedReason };

export type AttemptIndex = ReadonlyMap<string, readonly AttemptRow[]>;

export function indexAttemptsBySession(attempts: readonly AttemptRow[]): AttemptIndex {
  const bySession = new Map<string, AttemptRow[]>();
  for (const attempt of attempts) {
    if (attempt.sessionId.length === 0) continue;
    const list = bySession.get(attempt.sessionId);
    if (list === undefined) bySession.set(attempt.sessionId, [attempt]);
    else list.push(attempt);
  }
  for (const list of bySession.values()) list.sort((a, b) => a.startedAtMs - b.startedAtMs);
  return bySession;
}

// Claude subagent transcripts cross parent attempts and carry no parent identity.
const isClaudeChildTranscript = (provider: UsageProviderKind, transcriptPath: string | undefined) =>
  provider === "claude" && transcriptPath?.split(/[\\/]/).includes("subagents") === true;

export function attribute(
  index: AttemptIndex,
  record: Pick<UsageRecord, "provider" | "sessionId" | "timestampMs">,
  transcriptPath: string | undefined,
): Attribution {
  if (isClaudeChildTranscript(record.provider, transcriptPath)) return { _tag: "child_work" };
  if (record.sessionId.length === 0) return { _tag: "unmatched", reason: "no_session_id" };
  const attempts = index.get(record.sessionId);
  if (attempts === undefined) return { _tag: "unmatched", reason: "no_attempt_here" };
  const owner = attempts.findLast((attempt) => attempt.startedAtMs <= record.timestampMs);
  if (owner === undefined || (owner.endedAtMs !== null && owner.endedAtMs < record.timestampMs)) {
    return { _tag: "unmatched", reason: "outside_attempt" };
  }
  return { _tag: "attempt", attempt: owner };
}

const COMPARABLE_PROVIDERS: ReadonlySet<UsageProviderKind> = new Set(["claude", "codex"]);
const COMPARABLE_ORIGINS: ReadonlySet<UsageOrigin> = new Set(["user", "agent"]);

/** Spend of one attempt in one provider, model, and speed. */
export interface AttemptCell {
  readonly attempt: AttemptRow;
  readonly provider: UsageProviderKind;
  readonly model: string;
  readonly speed: UsageSpeed;
  modelCalls: number;
  promptTokens: number;
  outputTokens: number;
  usd: number;
}

export type CohortLedger = Omit<
  UsageCohortReport["ledger"],
  "incompleteSources" | "stampingSince" | "unmatched"
> & { readonly unmatched: readonly UsageCohortUnmatched[] };

export interface CohortScan {
  readonly ledger: CohortLedger;
  readonly cells: readonly AttemptCell[];
}

/** Collects the scan's priced records into a ledger and per-attempt cells. Every record lands in exactly one ledger bucket. */
export function makeCohortScan(attempts: readonly AttemptRow[]) {
  const index = indexAttemptsBySession(attempts);
  const cells = new Map<string, AttemptCell>();
  const unmatched = new Map<
    string,
    { -readonly [K in keyof UsageCohortUnmatched]: UsageCohortUnmatched[K] }
  >();
  const sums = {
    totalUsd: 0,
    attributedUsd: 0,
    beforeTrackingUsd: 0,
    childWorkUsd: 0,
    excludedOriginUsd: 0,
    unpricedRecords: 0,
  };

  const add = ({ record, costUsd, unpriced, transcriptPath }: PricedUsage) => {
    sums.totalUsd += costUsd;
    if (unpriced) sums.unpricedRecords += 1;
    const owner = attribute(index, record, transcriptPath);
    if (owner._tag === "child_work") {
      sums.childWorkUsd += costUsd;
      return;
    }
    if (owner._tag === "unmatched") {
      const key = `${owner.reason}\u0000${record.provider}`;
      const row = unmatched.get(key) ?? {
        reason: owner.reason,
        provider: record.provider,
        records: 0,
        usd: 0,
      };
      row.records += 1;
      row.usd += costUsd;
      unmatched.set(key, row);
      return;
    }
    const { attempt } = owner;
    sums.attributedUsd += costUsd;
    if (attempt.stamp === null) sums.beforeTrackingUsd += costUsd;
    else if (!COMPARABLE_ORIGINS.has(attempt.stamp.origin)) sums.excludedOriginUsd += costUsd;

    const key = `${attempt.attemptId}\u0000${record.provider}\u0000${record.model}\u0000${record.speed}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        attempt,
        provider: record.provider,
        model: record.model,
        speed: record.speed,
        modelCalls: 0,
        promptTokens: 0,
        outputTokens: 0,
        usd: 0,
      };
      cells.set(key, cell);
    }
    cell.modelCalls += 1;
    cell.promptTokens +=
      record.totals.uncachedInputTokens +
      record.totals.cachedInputTokens +
      record.totals.cacheCreationTokens;
    cell.outputTokens += record.totals.outputTokens;
    cell.usd += costUsd;
  };

  const finish = (): CohortScan => ({
    ledger: { ...sums, unmatched: [...unmatched.values()].sort((a, b) => b.usd - a.usd) },
    cells: [...cells.values()],
  });

  return { add, finish };
}

export type Arm = "base" | "test";

/** One thread's spend in one arm and segment; the unit the comparison resamples. */
export interface CompareCell {
  readonly threadId: string;
  readonly arm: Arm;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly speed: UsageSpeed;
  readonly runs: number;
  readonly modelCalls: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
}

/** Cells for one comparison. `armOf` returns null for an attempt that belongs to neither arm. */
export function comparisonCells(
  cells: readonly AttemptCell[],
  armOf: (stamp: AttemptStamp) => Arm | null,
): CompareCell[] {
  const merged = new Map<
    string,
    { -readonly [K in keyof CompareCell]: CompareCell[K] } & { readonly runIds: Set<string> }
  >();
  for (const cell of cells) {
    const { stamp } = cell.attempt;
    if (
      stamp === null ||
      !COMPARABLE_PROVIDERS.has(cell.provider) ||
      !COMPARABLE_ORIGINS.has(stamp.origin)
    ) {
      continue;
    }
    const arm = armOf(stamp);
    if (arm === null) continue;
    const { threadId, providerInstanceId } = cell.attempt;
    const key = [threadId, arm, providerInstanceId, cell.model, cell.speed].join("\u0000");
    let target = merged.get(key);
    if (target === undefined) {
      target = {
        threadId,
        arm,
        providerInstanceId,
        model: cell.model,
        speed: cell.speed,
        runs: 0,
        modelCalls: 0,
        promptTokens: 0,
        outputTokens: 0,
        usd: 0,
        runIds: new Set(),
      };
      merged.set(key, target);
    }
    target.runIds.add(cell.attempt.runId);
    target.modelCalls += cell.modelCalls;
    target.promptTokens += cell.promptTokens;
    target.outputTokens += cell.outputTokens;
    target.usd += cell.usd;
  }
  return [...merged.values()].map(({ runIds, ...rest }) => ({ ...rest, runs: runIds.size }));
}

type BuildRow = UsageCohortReport["builds"][number];

/** Builds in first-seen order, with the untracked remainder last. */
export function buildRows(
  cells: readonly AttemptCell[],
  firstSeenAtMs: ReadonlyMap<string, number>,
): BuildRow[] {
  type Group = {
    readonly threads: Set<string>;
    readonly runs: Set<string>;
    modelCalls: number;
    promptTokens: number;
    outputTokens: number;
    usd: number;
  };
  const builds = new Map<
    string | null,
    Map<string, Group & Pick<UsageCohortSegment, "providerInstanceId" | "model" | "speed">>
  >();
  for (const cell of cells) {
    const build = cell.attempt.stamp?.t3Version ?? null;
    const segments = builds.get(build) ?? new Map();
    builds.set(build, segments);
    const { providerInstanceId } = cell.attempt;
    const key = [providerInstanceId, cell.model, cell.speed].join("\u0000");
    let group = segments.get(key);
    if (group === undefined) {
      group = {
        providerInstanceId,
        model: cell.model,
        speed: cell.speed,
        threads: new Set(),
        runs: new Set(),
        modelCalls: 0,
        promptTokens: 0,
        outputTokens: 0,
        usd: 0,
      };
      segments.set(key, group);
    }
    group.threads.add(cell.attempt.threadId);
    group.runs.add(cell.attempt.runId);
    group.modelCalls += cell.modelCalls;
    group.promptTokens += cell.promptTokens;
    group.outputTokens += cell.outputTokens;
    group.usd += cell.usd;
  }
  const rank = (build: string | null) =>
    build === null
      ? Number.POSITIVE_INFINITY
      : (firstSeenAtMs.get(build) ?? Number.POSITIVE_INFINITY);
  return [...builds]
    .sort(([a], [b]) => rank(a) - rank(b) || String(a).localeCompare(String(b)))
    .map(([build, segments]) => {
      const firstSeen = build === null ? undefined : firstSeenAtMs.get(build);
      return {
        build,
        firstSeenAt:
          firstSeen === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(firstSeen)),
        segments: [...segments.values()]
          .sort((a, b) => b.usd - a.usd)
          .map(({ threads, runs, ...group }) => ({
            ...group,
            threads: threads.size,
            runs: runs.size,
          })),
      };
    });
}
