// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Replays real sessions under snip policies and reports dollars against billed list price.
// usage: node evals/cache-snip/simulate.ts <artifact dir> [days]
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { lookupRate } from "../../apps/server/src/usage/usagePricing.ts";
import type { Block, Call, Replay } from "./replay.ts";
import { loadRates } from "./usageRecords.ts";

interface CallRates {
  readonly read: number;
  readonly miss: number;
  readonly output: number;
  /** Multiplies input and output above the long-context limit. Null when the model has no such tier. */
  readonly longInput: number | null;
  readonly longOutput: number | null;
}

const LONG_CONTEXT_LIMIT = 272_000;
const GRACE_CALLS = 5;
const REFETCH_CALL_OUTPUT_TOKENS = 100;
// A fresh chat re-reads for a while. Without a gap, that growth alone would retrigger the cut.
const HEAD_CUT_COOLDOWN_CALLS = 20;
const USER_SEED_TOKENS = 5_000;

export interface Epoch {
  readonly calls: readonly Call[];
  readonly blocks: readonly Block[];
  readonly session: string;
  readonly firstIndex: number;
  readonly turnStarts: ReadonlySet<number>;
  /** The call index each call has in the original replay. Blocks use these. */
  readonly rates: readonly CallRates[];
}

export type RateMode = "t3Table" | "trueList" | "apiWrites";
export type { CallRates };

export function makeRateLookup(dir: string, mode: RateMode) {
  const table = loadRates(NodePath.join(dir, "usage-model-rates.json"));
  const document = (
    JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "usage-model-rates.json"), "utf8")) as {
      document: Record<string, Record<string, number>>;
    }
  ).document;
  const cache = new Map<string, CallRates>();
  return (model: string, subagent: boolean): CallRates => {
    const key = `${model}:${subagent}`;
    const held = cache.get(key);
    if (held !== undefined) return held;
    const rate = lookupRate(table, model);
    const entry = document[model];
    const provider = entry?.["litellm_provider"] as unknown as string | undefined;
    const anthropic = provider === "anthropic";
    const oneHourWrite = entry?.["cache_creation_input_token_cost_above_1hr"];
    const longKnown = entry?.["input_cost_per_token_above_272k_tokens"] !== undefined;
    const result: CallRates =
      rate === null
        ? { read: 0, miss: 0, output: 0, longInput: null, longOutput: null }
        : {
            read: rate.cacheReadCostPerToken,
            miss: anthropic
              ? // Main Claude sessions write 1h entries; T3's table prices them all at the 5m rate.
                mode !== "t3Table" && !subagent && oneHourWrite !== undefined
                ? oneHourWrite
                : rate.cacheCreationCostPerToken
              : // Codex rollouts report no writes. API billing on GPT-5.6+ charges 1.25x input for them.
                mode === "apiWrites"
                ? rate.cacheCreationCostPerToken
                : rate.inputCostPerToken,
            output: rate.outputCostPerToken,
            longInput: mode !== "t3Table" && longKnown ? 2 : null,
            longOutput: mode !== "t3Table" && longKnown ? 1.5 : null,
          };
    cache.set(key, result);
    return result;
  };
}

export const sessionKey = (file: string) =>
  NodeCrypto.createHash("sha1").update(file).digest("hex").slice(0, 12);

export function splitEpochs(
  replay: Replay,
  ratesFor: (model: string, subagent: boolean) => CallRates,
): Epoch[] {
  const subagent = replay.file.includes("/subagents/");
  const turnStarts = new Set(replay.turnStarts);
  const session = sessionKey(replay.file);
  const starts = replay.calls.flatMap((call, index) => (index === 0 || call.reset ? [index] : []));
  return starts.map((start, position) => {
    const stop = starts[position + 1] ?? replay.calls.length;
    const calls = replay.calls.slice(start, stop);
    return {
      calls,
      session,
      firstIndex: start,
      turnStarts,
      rates: calls.map((call) => ratesFor(call.model, subagent)),
      blocks: replay.blocks.filter((block) => block.arrival >= start && block.arrival < stop),
    };
  });
}

interface Tally {
  usd: number;
  snips: number;
  snippedTokens: number;
  refetches: number;
  refetchTokens: number;
  wrongSnips: number;
  seedTokens: number;
}
const emptyTally = (): Tally => ({
  usd: 0,
  snips: 0,
  snippedTokens: 0,
  refetches: 0,
  refetchTokens: 0,
  wrongSnips: 0,
  seedTokens: 0,
});

/** What a policy may look at before call `t`. Foresight lives only in selectors named oracle. */
export interface View {
  readonly epoch: Epoch;
  readonly t: number;
  readonly live: readonly Block[];
  readonly coldHint: boolean;
  /** A user message entered the prompt at this call: the natural boundary between tasks. */
  readonly userTurn: boolean;
  readonly prompt: number;
  readonly removedBefore: (arrival: number) => number;
}

export type Decide = (view: View) => readonly Block[];

export const LONG_LIMIT = LONG_CONTEXT_LIMIT;
const nextUse = (block: Block, after: number) => block.uses.find((use) => use > after) ?? null;

export interface RunOptions {
  readonly compactAt?: number;
  readonly summaryTokens?: number;
  readonly coldHintMinutes?: number;
  /** Share of wrong snips that actually make the agent fetch the content again. */
  readonly refetchRate?: number;
  /** Share of cuts whose kept prefix still misses, as when a fork lands on a cold cache. */
  readonly cutMissRate?: number;
  /** New chat seeded with the newest tokens only. No summary call, and the first request is fully uncached. */
  readonly headCut?: {
    readonly trigger: number;
    readonly keepTokens: number;
    readonly floor: number;
    readonly when: "userTurn" | "cold";
    /** Newest tokens always kept. The rest of `keepTokens` is the head budget, filled by `rank`. */
    readonly keepRecent?: number;
    /** Drops tool output from the newest window, so the seed can end up smaller than `keepRecent`. */
    readonly seedFilter?: (block: Block, t: number, epoch: Epoch) => boolean;
    /** Higher is kept first. Defaults to newest first, as T3's handoff does. */
    readonly rank?: (block: Block, t: number, epoch: Epoch) => number;
  };
  /** What a fresh chat re-reads because it lost context: added tokens and extra calls per head cut. */
  readonly reexplore?: { readonly tokens: number; readonly calls: number };
  /** Compact at exactly these calls. Used to price each candidate moment. */
  readonly compactCalls?: ReadonlySet<number>;
  /** Compact only at this moment, instead of whenever the prompt is over the limit. */
  readonly compactWhen?: "cold" | "userTurn" | "coldOrUserTurn";
}

/** One epoch under a policy. `compactAt` replaces everything but the base with a summary. */
export function runEpoch(
  epoch: Epoch,
  decide: Decide,
  cutoff: number,
  options: RunOptions = {},
): Tally {
  const tally = emptyTally();
  const { calls, blocks, firstIndex, rates } = epoch;
  const byArrival = new Map<number, Block[]>();
  for (const block of blocks) {
    const list = byArrival.get(block.arrival) ?? [];
    list.push(block);
    byArrival.set(block.arrival, list);
  }
  const base =
    calls[0]!.prompt -
    blocks.reduce((sum, block) => sum + (block.arrival === firstIndex ? block.tokens : 0), 0);
  const removedAt = new Map<Block, number>();
  const pendingRefetch = new Map<number, Block[]>();
  let live: Block[] = [];
  let removedTokens = 0;
  let tail = 0;
  // After a compaction the prompt is floor + what the real session appended since `anchor`.
  let compaction: { floor: number; anchorPrompt: number } | null = null;
  let lastCut = Number.NEGATIVE_INFINITY;

  const removedBefore = (arrival: number) => {
    let total = 0;
    for (const block of removedAt.keys()) if (block.arrival < arrival) total += block.tokens;
    return total;
  };
  const promptOf = (call: Call) =>
    compaction === null
      ? call.prompt - removedTokens + tail
      : compaction.floor + Math.max(0, call.prompt - compaction.anchorPrompt) + tail;
  const refetchRate = options.refetchRate ?? 1;
  const scheduleRefetch = (block: Block, t: number) => {
    const use = nextUse(block, t - 1);
    if (use === null) return;
    tally.wrongSnips += 1;
    // Not every later mention needs the bytes back. Deterministic so policies compare fairly.
    if (((block.arrival * 2654435761 + block.tokens) >>> 0) / 4294967296 >= refetchRate) return;
    const due = Math.max(use, t + 1);
    if (due - firstIndex >= calls.length) return;
    const list = pendingRefetch.get(due) ?? [];
    list.push(block);
    pendingRefetch.set(due, list);
  };

  const coldMinutes = options.coldHintMinutes ?? 60;
  calls.forEach((call, offset) => {
    const t = firstIndex + offset;
    const callRates = rates[offset]!;
    const previous = calls[offset - 1];
    live.push(...(byArrival.get(t) ?? []));

    const tierAt = (tokens: number) =>
      callRates.longInput !== null && tokens > LONG_CONTEXT_LIMIT
        ? { input: callRates.longInput, output: callRates.longOutput ?? 1 }
        : { input: 1, output: 1 };

    let extraUsd = 0;
    let tailFresh = 0;
    for (const block of pendingRefetch.get(t) ?? []) {
      if (!removedAt.has(block)) continue;
      removedAt.delete(block);
      if (compaction === null) removedTokens -= block.tokens;
      // Refetched content sits at the tail, so snipping it again only busts the tail.
      const refetched: Block = { ...block, arrival: t };
      const roundTrip = promptOf(call);
      const tier = tierAt(roundTrip);
      extraUsd +=
        Math.max(0, roundTrip - call.miss) * callRates.read * tier.input +
        REFETCH_CALL_OUTPUT_TOKENS * callRates.output * tier.output;
      tail += block.tokens;
      tailFresh += block.tokens;
      live.push(refetched);
      tally.refetches += 1;
      tally.refetchTokens += block.tokens;
    }
    pendingRefetch.delete(t);

    const gapMinutes = previous === undefined ? 0 : (call.ts - previous.ts) / 60_000;
    const toRemove = decide({
      epoch,
      t,
      live,
      coldHint: gapMinutes >= coldMinutes,
      userTurn: epoch.turnStarts.has(t),
      prompt: promptOf(call),
      removedBefore,
    });

    let prefixLimit = Number.POSITIVE_INFINITY;
    if (toRemove.length > 0) {
      const firstArrival = Math.min(...toRemove.map((block) => block.arrival));
      const offsetBefore = firstArrival - firstIndex - 1;
      const before = offsetBefore >= 0 ? calls[offsetBefore]!.prompt : base;
      prefixLimit = Math.max(0, before - removedBefore(firstArrival));
      if (((t * 2654435761 + call.prompt) >>> 0) / 4294967296 < (options.cutMissRate ?? 0)) {
        prefixLimit = 0;
      }
      const removing = new Set(toRemove);
      live = live.filter((block) => !removing.has(block));
      tally.snips += 1;
      for (const block of toRemove) {
        removedAt.set(block, t);
        removedTokens += block.tokens;
        tally.snippedTokens += block.tokens;
        scheduleRefetch(block, t);
      }
    }

    const moment = options.compactWhen;
    const userTurn = epoch.turnStarts.has(t);
    const cold = gapMinutes >= coldMinutes;
    const momentOk =
      moment === undefined ||
      (moment === "cold" && cold) ||
      (moment === "userTurn" && userTurn) ||
      (moment === "coldOrUserTurn" && (cold || userTurn));
    if (
      options.compactCalls?.has(t) === true ||
      (options.compactAt !== undefined && momentOk && promptOf(call) >= options.compactAt)
    ) {
      // Codex's prompt floor rises from 33k on a fresh session to 67k after compaction, so 30k survives.
      const summaryTokens = options.summaryTokens ?? 30_000;
      const beforeCompaction = promptOf(call);
      const tier = tierAt(beforeCompaction);
      extraUsd +=
        Math.max(0, beforeCompaction - call.miss) * callRates.read * tier.input +
        summaryTokens * callRates.output * tier.output;
      for (const block of live) {
        removedAt.set(block, t);
        tally.snippedTokens += block.tokens;
        scheduleRefetch(block, t);
      }
      live = [];
      tail = 0;
      tailFresh = 0;
      tally.snips += 1;
      compaction = { floor: base + summaryTokens, anchorPrompt: call.prompt };
      prefixLimit = base;
    }

    const cut = options.headCut;
    if (
      cut !== undefined &&
      promptOf(call) >= cut.trigger &&
      t - lastCut >= HEAD_CUT_COOLDOWN_CALLS &&
      (cut.when === "userTurn" ? userTurn : cold)
    ) {
      lastCut = t;
      const rank = cut.rank ?? ((block: Block) => block.arrival);
      const seedable = live.filter(
        (block) => block.kind !== "reasoning" && block.kind !== "tool_call",
      );
      const keep = new Set<Block>();
      let kept = 0;
      const take = (block: Block, limit: number) => {
        if (keep.has(block) || kept + block.tokens > limit) return;
        keep.add(block);
        kept += block.tokens;
      };
      // Instructions and the latest answer survive whatever the ranking says, as in T3's handoff.
      const newestFirst = seedable.toReversed();
      for (const block of newestFirst) if (block.kind === "user") take(block, USER_SEED_TOKENS);
      const latestAnswer = newestFirst.find((block) => block.kind === "assistant");
      if (latestAnswer !== undefined) take(latestAnswer, cut.keepTokens);
      const recent = cut.keepRecent ?? 0;
      let walked = 0;
      for (const block of newestFirst) {
        if ((cut.seedFilter === undefined ? kept : walked) >= recent) break;
        walked += block.tokens;
        if (block.kind === "tool_output" && cut.seedFilter?.(block, t, epoch) === false) continue;
        take(block, recent);
      }
      // A filtered seed is meant to end up small, so nothing tops it back up.
      const head =
        cut.seedFilter !== undefined
          ? []
          : seedable.filter(
              (block) => block.kind === "tool_output" || cut.keepRecent === undefined,
            );
      for (const block of head.toSorted((a, b) => rank(b, t, epoch) - rank(a, t, epoch))) {
        take(block, cut.keepTokens);
      }
      for (const block of live) {
        if (keep.has(block)) continue;
        removedAt.set(block, t);
        tally.snippedTokens += block.tokens;
        scheduleRefetch(block, t);
      }
      live = live.filter((block) => keep.has(block));
      const reexplore = options.reexplore ?? { tokens: 0, calls: 0 };
      tail = reexplore.tokens;
      tailFresh = reexplore.tokens;
      tally.snips += 1;
      tally.seedTokens += kept;
      compaction = { floor: cut.floor + kept, anchorPrompt: call.prompt };
      prefixLimit = 0;
      const fresh = cut.floor + kept + reexplore.tokens;
      const freshTier = tierAt(fresh);
      extraUsd +=
        reexplore.calls *
        (fresh * callRates.read * freshTier.input +
          REFETCH_CALL_OUTPUT_TOKENS * callRates.output * freshTier.output);
    }

    const prompt = promptOf(call);
    const tier = tierAt(prompt);
    const read = Math.min(Math.max(0, prompt - call.miss - tailFresh), prefixLimit);
    const usd =
      read * callRates.read * tier.input +
      (prompt - read) * callRates.miss * tier.input +
      call.output * callRates.output * tier.output +
      extraUsd;
    if (call.ts >= cutoff) tally.usd += usd;
  });
  return tally;
}

const never: Decide = () => [];

const isOutput = (block: Block) => block.kind === "tool_output";

/** Foresight: the block is never quoted again in this epoch. */
const deadOracle = (view: View) =>
  view.live.filter((block) => isOutput(block) && block.lastUse + GRACE_CALLS < view.t);

const supersededOnly = (view: View) =>
  view.live.filter(
    (block) =>
      isOutput(block) &&
      ((block.supersededAt !== null && block.supersededAt <= view.t) ||
        (block.rereadAt !== null && block.rereadAt <= view.t)),
  );

/** Least recently used: not quoted for `idle` calls. Uses only what has already happened. */
const idleFor = (idle: number, minTokens: number) => (view: View) =>
  view.live.filter((block) => {
    if (!isOutput(block) || block.tokens < minTokens) return false;
    let last = block.arrival;
    for (const use of block.uses) {
      if (use >= view.t) break;
      last = use;
    }
    return view.t - last > idle;
  });

/** Dead outputs plus old tool inputs and reasoning, for the widest ceiling. */
const deadPlusOld = (view: View) =>
  view.live.filter(
    (block) =>
      (isOutput(block) && block.lastUse + GRACE_CALLS < view.t) ||
      ((block.kind === "tool_call" || block.kind === "reasoning") && view.t - block.arrival > 50),
  );

/** Stand-in for a classifier of given AUC, thresholded at a false positive rate. Noise is fixed per block. */
const noisyClassifier = (auc: number, falsePositiveRate: number) => {
  const separation = Math.SQRT2 * inverseNormal(auc);
  const threshold = inverseNormal(1 - falsePositiveRate);
  return (view: View) =>
    view.live.filter((block) => {
      if (!isOutput(block)) return false;
      const dead = block.lastUse + GRACE_CALLS < view.t;
      const noise = blockNoise(block);
      return (dead ? separation : 0) + noise > threshold;
    });
};

function inverseNormal(p: number) {
  // Acklam's rational approximation, central region only: the AUCs and rates used here stay inside it.
  const q = p - 0.5;
  const r = q * q;
  return (
    (q *
      (((((-3.969683028665376e1 * r + 2.209460984245205e2) * r - 2.759285104469687e2) * r +
        1.38357751867269e2) *
        r -
        3.066479806614716e1) *
        r +
        2.506628277459239)) /
    (((((-5.447609879822406e1 * r + 1.615858368580409e2) * r - 1.556989798598866e2) * r +
      6.680131188771972e1) *
      r -
      1.328068155288572e1) *
      r +
      1)
  );
}

function blockNoise(block: Block) {
  const seed = (block.arrival * 2654435761 + block.tokens * 40503) >>> 0;
  const u1 = ((seed * 1664525 + 1013904223) >>> 0) / 4294967296 || 1e-9;
  const u2 = (((seed ^ 0x9e3779b9) * 22695477 + 1) >>> 0) / 4294967296;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Tool output from before the user's last message. The task boundary rule. */
const beforeLastUserTurn = (minTokens: number) => (view: View) => {
  let lastUser = -1;
  for (const block of view.live)
    if (block.kind === "user") lastUser = Math.max(lastUser, block.arrival);
  return view.live.filter(
    (block) => isOutput(block) && block.tokens >= minTokens && block.arrival < lastUser,
  );
};

const atUserTurn =
  (decide: Decide): Decide =>
  (view) =>
    view.userTurn ? decide(view) : [];

/**
 * Rewind: drop the finished turn's tool work and keep what the user saw. Everything before that turn is untouched,
 * so it stays cached and only the kept answer and the new message are rebuilt.
 */
const finishedTurnWork = (minTokens: number) => (view: View) => {
  const users = view.live.filter((block) => block.kind === "user" && block.arrival < view.t);
  const start = users.at(-1)?.arrival;
  if (start === undefined) return [];
  const chosen = view.live.filter(
    (block) =>
      block.arrival >= start &&
      block.arrival < view.t &&
      (block.kind === "tool_output" || block.kind === "tool_call" || block.kind === "reasoning"),
  );
  return chosen.reduce((sum, block) => sum + block.tokens, 0) >= minTokens ? chosen : [];
};

/** Snip only when the gap says the cache is already cold. */
const whenCold =
  (select: (view: View) => readonly Block[], minTokens: number): Decide =>
  (view) => {
    if (!view.coldHint) return [];
    const chosen = select(view);
    return chosen.reduce((sum, block) => sum + block.tokens, 0) >= minTokens ? chosen : [];
  };

/** Claude's clear_tool_uses semantics: oldest first, keep N, skip unless enough clears. */
const keepRecent =
  (trigger: number, keep: number, clearAtLeast: number): Decide =>
  (view) => {
    if (view.prompt < trigger) return [];
    const outputs = view.live.filter(isOutput);
    const candidates = outputs.slice(0, Math.max(0, outputs.length - keep));
    return candidates.reduce((sum, block) => sum + block.tokens, 0) >= clearAtLeast
      ? candidates
      : [];
  };

/**
 * Estimates remaining calls from room left before the provider compacts, and charges the rebuild honestly.
 * Counts the long-context cliff, where a snip that lands under the limit halves every later read.
 */
const whenRoomPays =
  (
    select: (view: View) => readonly Block[],
    compactLimit: number,
    margin: number,
    minShare: number,
  ): Decide =>
  (view) => {
    const chosen = select(view);
    if (chosen.length === 0) return [];
    const snipped = chosen.reduce((sum, block) => sum + block.tokens, 0);
    if (snipped < minShare * view.prompt) return [];
    const offset = view.t - view.epoch.firstIndex;
    if (offset < 5) return [];
    const rates = view.epoch.rates[offset]!;
    const start = view.epoch.calls[0]!.prompt;
    const growth = Math.max(200, (view.epoch.calls[offset]!.prompt - start) / offset);
    const room = Math.max(0, compactLimit - view.prompt) / growth;
    const remaining = Math.min(room, offset);
    const firstArrival = Math.min(...chosen.map((block) => block.arrival));
    const offsetBefore = firstArrival - view.epoch.firstIndex - 1;
    const before = offsetBefore >= 0 ? view.epoch.calls[offsetBefore]!.prompt : 0;
    const kept = Math.max(0, before - view.removedBefore(firstArrival));
    const after = view.prompt - snipped;
    const tier = (tokens: number) =>
      rates.longInput !== null && tokens > LONG_CONTEXT_LIMIT ? rates.longInput : 1;
    const rebuild =
      Math.max(0, after - kept) * rates.miss * tier(after) +
      kept * rates.read * tier(after) -
      view.prompt * rates.read * tier(view.prompt);
    const perCall = view.prompt * rates.read * tier(view.prompt) - after * rates.read * tier(after);
    return remaining * perCall > rebuild * margin ? chosen : [];
  };

/** Foresight on both relevance and remaining calls: best snip times found by repeated best-insert. */
function oracleDecide(
  epoch: Epoch,
  cutoff: number,
  select: (view: View) => readonly Block[],
): Decide {
  const count = epoch.calls.length;
  if (count < 3) return never;
  const step = Math.max(1, Math.floor(count / 60));
  const candidates: number[] = [];
  for (let offset = step; offset < count; offset += step)
    candidates.push(epoch.firstIndex + offset);
  const planned = new Set<number>();
  const planDecide: Decide = (view) => (planned.has(view.t) ? select(view) : []);
  let best = runEpoch(epoch, planDecide, cutoff).usd;
  for (let round = 0; round < 8; round += 1) {
    let bestTime: number | null = null;
    for (const time of candidates) {
      if (planned.has(time)) continue;
      planned.add(time);
      const usd = runEpoch(epoch, planDecide, cutoff).usd;
      planned.delete(time);
      if (usd < best - 1e-9) {
        best = usd;
        bestTime = time;
      }
    }
    if (bestTime === null) break;
    planned.add(bestTime);
  }
  return planDecide;
}

interface PolicyDefinition {
  readonly name: string;
  readonly make: (epoch: Epoch, cutoff: number) => Decide;
  readonly options?: RunOptions;
}

const stateless = (
  name: string,
  decide: Decide,
  options?: PolicyDefinition["options"],
): PolicyDefinition => ({
  name,
  make: () => decide,
  ...(options === undefined ? {} : { options }),
});

/** Out-of-fold scores from relevance.py, keyed session:t:block. */
let relevanceScores: ReadonlyMap<string, number> = new Map();

const lastSeenUse = (block: Block, t: number) => {
  let last = block.arrival;
  for (const use of block.uses) {
    if (use >= t) break;
    last = use;
  }
  return last;
};

const SELECTORS: ReadonlyArray<
  readonly [string, NonNullable<NonNullable<RunOptions["headCut"]>["rank"]>]
> = [
  ["newest first", (block) => block.arrival],
  ["least recently used", (block, t) => lastSeenUse(block, t)],
  [
    "named by the new message, then LRU",
    (block, t) => (block.mentions.includes(t) ? 1e9 : 0) + lastSeenUse(block, t),
  ],
  [
    "trained on numeric features",
    (block, t, epoch) =>
      block.kind === "tool_output"
        ? (relevanceScores.get(`${epoch.session}:${t}:${block.id}`) ?? 0)
        : 1,
  ],
  ...[0.75, 0.85, 0.95].map(
    (auc) =>
      [
        `stand-in AUC ${auc}`,
        (block: Block, t: number) =>
          (nextUse(block, t - 1) !== null ? Math.SQRT2 * inverseNormal(auc) : 0) +
          blockNoise(block),
      ] as const,
  ),
  ["oracle", (block, t) => (nextUse(block, t - 1) !== null ? 1e9 : 0) + block.arrival],
];
const idleCalls = (block: Block, t: number) => t - lastSeenUse(block, t);
const standInFilter = (auc: number, falsePositiveRate: number) => {
  const separation = Math.SQRT2 * inverseNormal(auc);
  const threshold = inverseNormal(1 - falsePositiveRate);
  return (block: Block, t: number) =>
    // Here "positive" means still needed, so the rate is how often an unneeded block slips through.
    (nextUse(block, t - 1) !== null ? separation : 0) + blockNoise(block) > threshold;
};
const SEED_FILTERS: ReadonlyArray<
  readonly [string, (block: Block, t: number, epoch: Epoch) => boolean]
> = [
  ["no tool output at all", () => false],
  ["used in the last 5 calls", (block, t) => idleCalls(block, t) <= 5],
  ["used in the last 20 calls", (block, t) => idleCalls(block, t) <= 20],
  [
    "named by the message, or used in the last 5",
    (block, t) => block.mentions.includes(t) || idleCalls(block, t) <= 5,
  ],
  [
    "numeric model, p over 0.3",
    (block, t, epoch) => (relevanceScores.get(`${epoch.session}:${t}:${block.id}`) ?? 0) > 0.3,
  ],
  ["stand-in AUC 0.85, lets 30% of unneeded through", standInFilter(0.85, 0.3)],
  ["stand-in AUC 0.95, lets 30% of unneeded through", standInFilter(0.95, 0.3)],
  ["oracle: only blocks used again", (block, t) => nextUse(block, t - 1) !== null],
];
const PRUNE_CONFIGS = [
  { trigger: 150_000, keepRecent: 20_000, keepTokens: 20_000, when: "userTurn" },
  { trigger: 150_000, keepRecent: 50_000, keepTokens: 50_000, when: "userTurn" },
  { trigger: 100_000, keepRecent: 20_000, keepTokens: 20_000, when: "cold" },
] as const;
const SELECTION_CONFIGS = [
  { trigger: 150_000, keepRecent: 20_000, keepTokens: 20_000, when: "userTurn" },
  { trigger: 150_000, keepRecent: 20_000, keepTokens: 30_000, when: "userTurn" },
  { trigger: 150_000, keepRecent: 20_000, keepTokens: 50_000, when: "userTurn" },
  { trigger: 150_000, keepRecent: 20_000, keepTokens: 80_000, when: "userTurn" },
  { trigger: 260_000, keepRecent: 20_000, keepTokens: 50_000, when: "userTurn" },
  { trigger: 100_000, keepRecent: 20_000, keepTokens: 50_000, when: "cold" },
] as const;

const REFETCH = Number(process.env["CACHE_SNIP_REFETCH"] ?? 1);
const CUT_MISS = Number(process.env["CACHE_SNIP_CUT_MISS"] ?? 0);
const [REEXPLORE_TOKENS, REEXPLORE_CALLS] = (process.env["CACHE_SNIP_REEXPLORE"] ?? "0,0")
  .split(",")
  .map(Number);
const LIMITS: Readonly<Record<string, number>> = { codex: 318_000, claude: 700_000 };

export const policiesFor = (provider: string): readonly PolicyDefinition[] => {
  const limit = LIMITS[provider] ?? 300_000;
  // Median first prompt of a fresh session: system, tools, and instructions.
  const floor = provider === "claude" ? 49_000 : 33_000;
  const cutAt = (trigger: number, keepTokens: number, when: "userTurn" | "cold") =>
    rule(`head cut over ${trigger / 1000}k keep ${keepTokens / 1000}k, ${when}`, never, {
      headCut: { trigger, keepTokens, floor, when },
      reexplore: { tokens: REEXPLORE_TOKENS ?? 0, calls: REEXPLORE_CALLS ?? 0 },
    });
  const withRefetch = { refetchRate: REFETCH, cutMissRate: CUT_MISS };
  const rule = (name: string, decide: Decide, options: RunOptions = {}) =>
    stateless(name, decide, { ...withRefetch, ...options });
  return [
    rule("never", never),
    {
      name: "CEILING dead+old + oracle timing",
      make: (epoch, cutoff) => oracleDecide(epoch, cutoff, deadPlusOld),
      options: withRefetch,
    },
    {
      name: "CEILING dead outputs + oracle timing",
      make: (epoch, cutoff) => oracleDecide(epoch, cutoff, deadOracle),
      options: withRefetch,
    },
    rule("dead + room rule m1 s10%", whenRoomPays(deadOracle, limit, 1, 0.1)),
    rule("dead + room rule m2 s15%", whenRoomPays(deadOracle, limit, 2, 0.15)),
    rule("dead + cold only", whenCold(deadOracle, 5_000)),
    {
      name: "idle>30 + oracle timing",
      make: (epoch, cutoff) => oracleDecide(epoch, cutoff, idleFor(30, 200)),
      options: withRefetch,
    },
    rule("idle>10 + room rule m2 s15%", whenRoomPays(idleFor(10, 200), limit, 2, 0.15)),
    rule("idle>30 + room rule m2 s15%", whenRoomPays(idleFor(30, 200), limit, 2, 0.15)),
    rule("idle>60 + room rule m2 s15%", whenRoomPays(idleFor(60, 200), limit, 2, 0.15)),
    rule("idle>30 + cold only", whenCold(idleFor(30, 200), 5_000)),
    rule("idle>10 + cold only", whenCold(idleFor(10, 200), 5_000)),
    rule("superseded + cold only", whenCold(supersededOnly, 2_000)),
    ...[100_000, 150_000, 200_000, 260_000].flatMap((trigger) =>
      [5_000, 20_000, 50_000, 100_000].map((keep) => cutAt(trigger, keep, "userTurn")),
    ),
    cutAt(100_000, 20_000, "cold"),
    cutAt(100_000, 50_000, "cold"),
    ...PRUNE_CONFIGS.flatMap((config) => [
      rule(
        `prune ${config.trigger / 1000}k/${config.keepRecent / 1000}k/${config.when}: keep all`,
        never,
        {
          headCut: { ...config, floor },
          reexplore: { tokens: REEXPLORE_TOKENS ?? 0, calls: REEXPLORE_CALLS ?? 0 },
        },
      ),
      ...SEED_FILTERS.map(([name, seedFilter]) =>
        rule(
          `prune ${config.trigger / 1000}k/${config.keepRecent / 1000}k/${config.when}: ${name}`,
          never,
          {
            headCut: { ...config, floor, seedFilter },
            reexplore: { tokens: REEXPLORE_TOKENS ?? 0, calls: REEXPLORE_CALLS ?? 0 },
          },
        ),
      ),
    ]),
    ...SELECTION_CONFIGS.flatMap((config) =>
      SELECTORS.map(([name, rank]) =>
        rule(
          `select ${config.trigger / 1000}k/head${(config.keepTokens - config.keepRecent) / 1000}k/${config.when}: ${name}`,
          never,
          {
            headCut: { ...config, floor, rank },
            reexplore: { tokens: REEXPLORE_TOKENS ?? 0, calls: REEXPLORE_CALLS ?? 0 },
          },
        ),
      ),
    ),
    rule("rewind finished turn, over 2k", atUserTurn(finishedTurnWork(2_000))),
    rule("rewind finished turn, over 10k", atUserTurn(finishedTurnWork(10_000))),
    rule("rewind finished turn, over 30k", atUserTurn(finishedTurnWork(30_000))),
    rule("prior turns + cold only", whenCold(beforeLastUserTurn(200), 5_000)),
    rule(
      "prior turns at user turn, room m2 s15%",
      atUserTurn(whenRoomPays(beforeLastUserTurn(200), limit, 2, 0.15)),
    ),
    rule(
      "prior turns at user turn, room m1 s25%",
      atUserTurn(whenRoomPays(beforeLastUserTurn(200), limit, 1, 0.25)),
    ),
    rule("AUC.75 fpr5% + room m2 s15%", whenRoomPays(noisyClassifier(0.75, 0.05), limit, 2, 0.15)),
    rule("AUC.85 fpr5% + room m2 s15%", whenRoomPays(noisyClassifier(0.85, 0.05), limit, 2, 0.15)),
    rule("AUC.95 fpr5% + room m2 s15%", whenRoomPays(noisyClassifier(0.95, 0.05), limit, 2, 0.15)),
    rule("AUC.85 fpr10% + room m2 s15%", whenRoomPays(noisyClassifier(0.85, 0.1), limit, 2, 0.15)),
    rule("AUC.95 fpr10% + room m2 s15%", whenRoomPays(noisyClassifier(0.95, 0.1), limit, 2, 0.15)),
    rule("AUC.85 fpr30% + room m2 s15%", whenRoomPays(noisyClassifier(0.85, 0.3), limit, 2, 0.15)),
    rule("AUC.95 fpr30% + room m2 s15%", whenRoomPays(noisyClassifier(0.95, 0.3), limit, 2, 0.15)),
    rule("AUC.85 fpr5% + cold only", whenCold(noisyClassifier(0.85, 0.05), 5_000)),
    rule("keep3 trigger100k no-min (docs default)", keepRecent(100_000, 3, 0)),
    rule("keep30 trigger200k min75k", keepRecent(200_000, 30, 75_000)),
    rule("keep60 trigger250k min100k", keepRecent(250_000, 60, 100_000)),
    rule("keep30 trigger400k min150k", keepRecent(400_000, 30, 150_000)),
    rule("compact at 200k", never, { compactAt: 200_000 }),
    rule("compact at 260k", never, { compactAt: 260_000 }),
    rule("compact at 400k", never, { compactAt: 400_000 }),
    rule("compact when cold, over 100k", never, { compactAt: 100_000, compactWhen: "cold" }),
    rule("compact when cold, over 150k", never, { compactAt: 150_000, compactWhen: "cold" }),
    rule("compact at user turn, over 150k", never, { compactAt: 150_000, compactWhen: "userTurn" }),
    rule("compact at user turn, over 200k", never, { compactAt: 200_000, compactWhen: "userTurn" }),
    rule("compact at user turn, over 260k", never, { compactAt: 260_000, compactWhen: "userTurn" }),
  ];
};

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined) throw new Error("usage: simulate.ts <artifact dir> [days]");
  const days = Number(process.argv[3] ?? 30);
  const scoresPath = NodePath.join(dir, "relevance-scores.csv");
  if (NodeFS.existsSync(scoresPath)) {
    relevanceScores = new Map(
      NodeFS.readFileSync(scoresPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const [key, value] = line.split(",");
          return [key ?? "", Number(value)] as const;
        }),
    );
  }
  const replays = NodeFS.readdirSync(NodePath.join(dir, "replay")).map(
    (name) => JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "replay", name), "utf8")) as Replay,
  );
  const latest = Math.max(...replays.flatMap((replay) => replay.calls.map((call) => call.ts)));
  const cutoff = latest - days * 86_400_000;

  const billed = new Map<string, number>();
  for (const replay of replays) {
    const inWindow = replay.calls.filter((call) => call.ts >= cutoff);
    billed.set(
      replay.provider,
      (billed.get(replay.provider) ?? 0) + inWindow.reduce((sum, call) => sum + call.usd, 0),
    );
  }

  // Gate: the no-snip replay at T3's rates must reproduce what T3 priced.
  const t3Rates = makeRateLookup(dir, "t3Table");
  for (const provider of ["codex", "claude"]) {
    let simulated = 0;
    for (const replay of replays.filter((candidate) => candidate.provider === provider)) {
      for (const epoch of splitEpochs(replay, t3Rates))
        simulated += runEpoch(epoch, never, cutoff).usd;
    }
    const target = billed.get(provider) ?? 0;
    console.log(
      `gate ${provider}: simulated no-snip $${simulated.toFixed(2)} vs T3-priced $${target.toFixed(2)} (${(((simulated - target) / target) * 100).toFixed(2)}%)`,
    );
  }

  const ratesFor = makeRateLookup(dir, (process.env["CACHE_SNIP_RATES"] ?? "trueList") as RateMode);
  const results: Record<string, Record<string, number[]>> = {};
  for (const provider of ["codex", "claude"]) {
    const subset = replays.filter((candidate) => candidate.provider === provider);
    const perSession = policiesFor(provider).map((policy) => {
      const usd: number[] = [];
      let snips = 0;
      let snipped = 0;
      let refetches = 0;
      let refetchTokens = 0;
      let wrong = 0;
      let seed = 0;
      for (const replay of subset) {
        let sessionUsd = 0;
        for (const epoch of splitEpochs(replay, ratesFor)) {
          const tally = runEpoch(epoch, policy.make(epoch, cutoff), cutoff, policy.options ?? {});
          sessionUsd += tally.usd;
          snips += tally.snips;
          snipped += tally.snippedTokens;
          refetches += tally.refetches;
          refetchTokens += tally.refetchTokens;
          wrong += tally.wrongSnips;
          seed += tally.seedTokens;
        }
        usd.push(sessionUsd);
      }
      return { name: policy.name, usd, snips, snipped, refetches, refetchTokens, wrong, seed };
    });
    const baseline = perSession[0]!.usd;
    const baselineTotal = baseline.reduce((sum, value) => sum + value, 0);
    console.log(
      `\n== ${provider}, true list baseline $${baselineTotal.toFixed(0)} over ${subset.length} sessions, last ${days} days`,
    );
    console.log(
      "policy".padEnd(44) +
        "   usd   saved  save%   [95% CI]    snips  snipMtok refetch wrong refMtok",
    );
    results[provider] = {};
    const random = seeded(7);
    for (const row of perSession) {
      const total = row.usd.reduce((sum, value) => sum + value, 0);
      const samples: number[] = [];
      for (let iteration = 0; iteration < 400; iteration += 1) {
        let base = 0;
        let policy = 0;
        for (let draw = 0; draw < baseline.length; draw += 1) {
          const pick = Math.floor(random() * baseline.length);
          base += baseline[pick]!;
          policy += row.usd[pick]!;
        }
        samples.push((base - policy) / Math.max(base, 1e-9));
      }
      samples.sort((a, b) => a - b);
      const low = samples[Math.floor(0.025 * samples.length)]!;
      const high = samples[Math.floor(0.975 * samples.length)]!;
      results[provider]![row.name] = [
        total,
        low,
        high,
        row.refetchTokens,
        row.snips,
        row.snipped,
        row.seed,
      ];
      console.log(
        row.name.padEnd(44) +
          total.toFixed(0).padStart(6) +
          (baselineTotal - total).toFixed(0).padStart(8) +
          `${(((baselineTotal - total) / baselineTotal) * 100).toFixed(1)}%`.padStart(7) +
          ` [${(low * 100).toFixed(1)},${(high * 100).toFixed(1)}]`.padStart(14) +
          String(row.snips).padStart(7) +
          (row.snipped / 1e6).toFixed(0).padStart(9) +
          String(row.refetches).padStart(8) +
          String(row.wrong).padStart(6) +
          (row.refetchTokens / 1e6).toFixed(1).padStart(7),
      );
    }
  }
  NodeFS.writeFileSync(
    NodePath.join(dir, "simulate-results.json"),
    JSON.stringify(results, null, 1),
  );
}

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
