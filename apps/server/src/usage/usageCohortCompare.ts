import type {
  UsageCohortComparison,
  UsageCohortTotals,
  UsageCohortVerdict,
} from "@t3tools/contracts";

import type { Arm, CompareCell } from "./usageCohortJoin.ts";

const MIN_THREADS_PER_ARM = 30;
const BOOTSTRAP_RESAMPLES = 1000;
const MAX_SEGMENTS_PER_COMPARISON = 12;
const RESAMPLES_PER_YIELD = 50;
const MATERIAL_RATIO = 1.15;
const LOG_MATERIAL = Math.log(MATERIAL_RATIO);
const TAIL = 0.005;

export interface CompareInput {
  /** Seeds the bootstrap, so the same comparison always returns the same verdict. */
  readonly key: string;
  readonly cells: readonly CompareCell[];
  readonly windowDays: number;
  readonly random?: () => number;
}

export type CompareResult = Pick<
  UsageCohortComparison,
  "base" | "test" | "threadsSpanningArms" | "promptTokensPerCall" | "usdPerRun" | "segments"
>;

interface Metric {
  readonly numerator: "promptTokens" | "usd";
  readonly denominator: "modelCalls" | "runs";
}

const METRICS = {
  promptTokensPerCall: { numerator: "promptTokens", denominator: "modelCalls" },
  usdPerRun: { numerator: "usd", denominator: "runs" },
} as const satisfies Record<string, Metric>;

type MetricName = keyof typeof METRICS;

interface Quantities {
  promptTokens: number;
  modelCalls: number;
  usd: number;
  runs: number;
}

const zeroQuantities = (): Quantities => ({ promptTokens: 0, modelCalls: 0, usd: 0, runs: 0 });

interface ThreadCell extends Quantities {
  readonly stratum: number;
}

type Thread = readonly ThreadCell[];

// FNV-1a into mulberry32: small, dependency free, and stable across runtimes.
function seededRandom(key: string): () => number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weighted mean of per-stratum log ratios over strata present in both arms, or null when none. */
function logRatio(
  metric: Metric,
  base: readonly Quantities[],
  test: readonly Quantities[],
  baseThreads: ArrayLike<number>,
  testThreads: ArrayLike<number>,
): number | null {
  let weighted = 0;
  let weights = 0;
  for (let stratum = 0; stratum < base.length; stratum += 1) {
    const b = base[stratum]!;
    const t = test[stratum]!;
    const baseDenominator = b[metric.denominator];
    const testDenominator = t[metric.denominator];
    const baseNumerator = b[metric.numerator];
    const testNumerator = t[metric.numerator];
    if (baseDenominator <= 0 || testDenominator <= 0 || baseNumerator <= 0 || testNumerator <= 0) {
      continue;
    }
    const weight = baseThreads[stratum]! + testThreads[stratum]!;
    weighted +=
      weight * Math.log(testNumerator / testDenominator / (baseNumerator / baseDenominator));
    weights += weight;
  }
  return weights === 0 ? null : weighted / weights;
}

function sumArm(threads: readonly Thread[], strata: number) {
  const sums = Array.from({ length: strata }, zeroQuantities);
  const present = new Float64Array(strata);
  for (const thread of threads) {
    for (const cell of thread) {
      const sum = sums[cell.stratum]!;
      sum.promptTokens += cell.promptTokens;
      sum.modelCalls += cell.modelCalls;
      sum.usd += cell.usd;
      sum.runs += cell.runs;
    }
    for (const stratum of new Set(thread.map((cell) => cell.stratum))) present[stratum]! += 1;
  }
  return { sums, present };
}

function quantile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))]!;
}

function verdictFrom(
  point: number | null,
  interval: { readonly low: number; readonly high: number } | null,
  threads: { readonly base: number; readonly test: number },
  windowDays: number,
): UsageCohortVerdict {
  const smaller = Math.min(threads.base, threads.test);
  const estimate = (): Pick<
    Extract<UsageCohortVerdict, { _tag: "not_enough_data" }>,
    "threadsPerArmFor15Percent" | "daysAtCurrentRate"
  > => {
    if (interval === null || smaller === 0) {
      return { threadsPerArmFor15Percent: null, daysAtCurrentRate: null };
    }
    const halfWidth = (Math.log(interval.high) - Math.log(interval.low)) / 2;
    const needed = Math.max(
      MIN_THREADS_PER_ARM,
      Math.ceil(smaller * (halfWidth / LOG_MATERIAL) ** 2),
    );
    return {
      threadsPerArmFor15Percent: needed,
      daysAtCurrentRate: Math.ceil((windowDays * needed) / smaller),
    };
  };
  if (smaller < MIN_THREADS_PER_ARM) {
    return { _tag: "not_enough_data", reason: "too_few_threads", ...estimate() };
  }
  if (point === null || interval === null) {
    return {
      _tag: "not_enough_data",
      reason: "interval_too_wide",
      threadsPerArmFor15Percent: null,
      daysAtCurrentRate: null,
    };
  }
  const ratio = Math.exp(point);
  if (interval.low > 1 || interval.high < 1) {
    return { _tag: "changed", ratio, ...interval };
  }
  if (interval.low >= 1 / MATERIAL_RATIO && interval.high <= MATERIAL_RATIO) {
    return { _tag: "no_detectable_change", ratio, ...interval };
  }
  return { _tag: "not_enough_data", reason: "interval_too_wide", ...estimate() };
}

const totalsOf = (cells: readonly CompareCell[]): UsageCohortTotals => ({
  threads: new Set(cells.map((cell) => cell.threadId)).size,
  runs: cells.reduce((sum, cell) => sum + cell.runs, 0),
  modelCalls: cells.reduce((sum, cell) => sum + cell.modelCalls, 0),
  promptTokens: cells.reduce((sum, cell) => sum + cell.promptTokens, 0),
  outputTokens: cells.reduce((sum, cell) => sum + cell.outputTokens, 0),
  usd: cells.reduce((sum, cell) => sum + cell.usd, 0),
});

/**
 * Compares two arms. A thread is the resampling unit and keeps all its cells, so cells that
 * belong to one thread stay dependent. Yields between batches of resamples so a caller can
 * give the event loop back.
 */
export function* compareArms(input: CompareInput): Generator<void, CompareResult> {
  const armsByThread = new Map<string, Set<Arm>>();
  for (const cell of input.cells) {
    const arms = armsByThread.get(cell.threadId) ?? new Set();
    arms.add(cell.arm);
    armsByThread.set(cell.threadId, arms);
  }
  const spanning = new Set([...armsByThread].filter(([, arms]) => arms.size > 1).map(([id]) => id));
  const cells = input.cells.filter((cell) => !spanning.has(cell.threadId));

  const stratumIndex = new Map<string, number>();
  const strataCells: CompareCell[] = [];
  const grouped: Record<Arm, Map<string, ThreadCell[]>> = { base: new Map(), test: new Map() };
  for (const cell of cells) {
    const stratumKey = [cell.providerInstanceId, cell.model, cell.speed].join("\u0000");
    let stratum = stratumIndex.get(stratumKey);
    if (stratum === undefined) {
      stratum = stratumIndex.size;
      stratumIndex.set(stratumKey, stratum);
      strataCells.push(cell);
    }
    const thread = grouped[cell.arm].get(cell.threadId) ?? [];
    thread.push({
      stratum,
      promptTokens: cell.promptTokens,
      modelCalls: cell.modelCalls,
      usd: cell.usd,
      runs: cell.runs,
    });
    grouped[cell.arm].set(cell.threadId, thread);
  }
  const strata = stratumIndex.size;
  const baseThreads = [...grouped.base.values()];
  const testThreads = [...grouped.test.values()];

  const baseSum = sumArm(baseThreads, strata);
  const testSum = sumArm(testThreads, strata);
  const metricNames = Object.keys(METRICS) as MetricName[];
  const points = Object.fromEntries(
    metricNames.map((name) => [
      name,
      logRatio(METRICS[name], baseSum.sums, testSum.sums, baseSum.present, testSum.present),
    ]),
  ) as Record<MetricName, number | null>;

  const samples: Record<MetricName, number[]> = { promptTokensPerCall: [], usdPerRun: [] };
  if (baseThreads.length > 0 && testThreads.length > 0) {
    const random = input.random ?? seededRandom(input.key);
    const draw = (threads: readonly Thread[]) =>
      sumArm(
        threads.map(() => threads[Math.floor(random() * threads.length)]!),
        strata,
      );
    for (let resample = 0; resample < BOOTSTRAP_RESAMPLES; resample += 1) {
      const base = draw(baseThreads);
      const test = draw(testThreads);
      for (const name of metricNames) {
        const value = logRatio(METRICS[name], base.sums, test.sums, base.present, test.present);
        if (value !== null && Number.isFinite(value)) samples[name].push(value);
      }
      if ((resample + 1) % RESAMPLES_PER_YIELD === 0) yield;
    }
  }

  const threads = { base: baseThreads.length, test: testThreads.length };
  const verdict = (name: MetricName): UsageCohortVerdict => {
    const sorted = samples[name].toSorted((a, b) => a - b);
    const interval =
      sorted.length < 2
        ? null
        : { low: Math.exp(quantile(sorted, TAIL)), high: Math.exp(quantile(sorted, 1 - TAIL)) };
    return verdictFrom(points[name], interval, threads, input.windowDays);
  };

  const byArm = (arm: Arm) => cells.filter((cell) => cell.arm === arm);
  const segments = strataCells
    .map((sample) => {
      const inSegment = (arm: Arm) =>
        byArm(arm).filter(
          (cell) =>
            cell.providerInstanceId === sample.providerInstanceId &&
            cell.model === sample.model &&
            cell.speed === sample.speed,
        );
      const base = totalsOf(inSegment("base"));
      const test = totalsOf(inSegment("test"));
      return {
        providerInstanceId: sample.providerInstanceId,
        model: sample.model,
        speed: sample.speed,
        base,
        test,
      };
    })
    .toSorted((a, b) => b.base.usd + b.test.usd - (a.base.usd + a.test.usd))
    .slice(0, MAX_SEGMENTS_PER_COMPARISON);

  return {
    base: totalsOf(byArm("base")),
    test: totalsOf(byArm("test")),
    threadsSpanningArms: spanning.size,
    promptTokensPerCall: verdict("promptTokensPerCall"),
    usdPerRun: verdict("usdPerRun"),
    segments,
  };
}
