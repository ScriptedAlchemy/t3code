import { describe, expect, it } from "@effect/vitest";

import { compareArms, type CompareInput } from "./usageCohortCompare.ts";
import type { Arm, CompareCell } from "./usageCohortJoin.ts";

const run = (input: CompareInput) => {
  const steps = compareArms(input);
  for (let step = steps.next(); ; step = steps.next()) {
    if (step.done) return step.value;
  }
};

const cell = (arm: Arm, index: number, overrides: Partial<CompareCell> = {}): CompareCell => ({
  threadId: `${arm}-${index}`,
  arm,
  providerInstanceId: "codex",
  model: "gpt-6.1-sol",
  speed: "standard",
  runs: 1,
  modelCalls: 10,
  promptTokens: 1000,
  outputTokens: 50,
  usd: 1,
  ...overrides,
});

const cells = (arm: Arm, count: number, at: (index: number) => Partial<CompareCell> = () => ({})) =>
  Array.from({ length: count }, (_, index) => cell(arm, index, at(index)));

const base = { key: "experiment:flag", windowDays: 14 };
const noisy = (index: number) => 1 + (index % 5) * 0.1;

describe("compareArms verdicts", () => {
  it("is not enough data below the thread floor, with the arm totals still visible", () => {
    const result = run({ ...base, cells: [...cells("base", 29), ...cells("test", 40)] });

    expect(result.promptTokensPerCall).toMatchObject({
      _tag: "not_enough_data",
      reason: "too_few_threads",
    });
    expect(result.usdPerRun).toMatchObject({ _tag: "not_enough_data", reason: "too_few_threads" });
    expect(result.base).toMatchObject({ threads: 29, usd: 29 });
  });

  it("gives null estimates when an arm is empty", () => {
    const result = run({ ...base, cells: cells("test", 40) });

    expect(result.usdPerRun).toEqual({
      _tag: "not_enough_data",
      reason: "too_few_threads",
      threadsPerArmFor15Percent: null,
      daysAtCurrentRate: null,
    });
  });

  it("reports a clear shift as changed with an interval around the ratio", () => {
    const result = run({
      ...base,
      cells: [
        ...cells("base", 40, (i) => ({ usd: noisy(i) })),
        ...cells("test", 40, (i) => ({ usd: 2 * noisy(i) })),
      ],
    });

    expect(result.usdPerRun).toMatchObject({ _tag: "changed", ratio: expect.closeTo(2, 5) });
    const verdict = result.usdPerRun;
    if (verdict._tag !== "changed") throw new Error("expected changed");
    expect(verdict.low).toBeGreaterThan(1.5);
    expect(verdict.high).toBeLessThan(2.6);
    expect(result.promptTokensPerCall._tag).toBe("no_detectable_change");
  });

  it("reports tight identical arms as no detectable change", () => {
    const result = run({ ...base, cells: [...cells("base", 40), ...cells("test", 40)] });

    expect(result.usdPerRun).toEqual({ _tag: "no_detectable_change", ratio: 1, low: 1, high: 1 });
  });

  it("sizes the data it would need when the interval straddles the material band", () => {
    const heavyTail = (shift: number) => (i: number) => ({ usd: i % 10 === 0 ? 30 * shift : 1 });
    const result = run({
      ...base,
      cells: [...cells("base", 40, heavyTail(1)), ...cells("test", 40, heavyTail(1.1))],
    });
    const verdict = result.usdPerRun;

    expect(verdict._tag).toBe("not_enough_data");
    if (verdict._tag !== "not_enough_data") return;
    expect(verdict.reason).toBe("interval_too_wide");
    expect(verdict.threadsPerArmFor15Percent).toBeGreaterThan(40);
    expect(verdict.daysAtCurrentRate).toBeGreaterThan(14);
    expect(verdict).not.toHaveProperty("ratio");
  });
});

describe("compareArms policy", () => {
  it("returns a ratio of 1 for equal per-stratum values at different stratum proportions", () => {
    const a = { model: "model-a", usd: 1 };
    const b = { model: "model-b", usd: 10 };
    const mix = (arm: Arm, aThreads: number, bThreads: number) => [
      ...cells(arm, aThreads, () => a),
      ...cells(arm, bThreads, (i) => ({ ...b, threadId: `${arm}-b-${i}` })),
    ];
    const result = run({ ...base, cells: [...mix("base", 60, 10), ...mix("test", 10, 60)] });

    expect(result.usdPerRun).toMatchObject({ _tag: "no_detectable_change", ratio: 1 });
    expect(result.test.usd).toBeGreaterThan(result.base.usd * 3);
  });

  it("excludes a thread that appears in both arms and counts it", () => {
    const spanning = [
      cell("base", 0, { threadId: "both", usd: 500 }),
      cell("test", 0, { threadId: "both", usd: 500 }),
    ];
    const result = run({
      ...base,
      cells: [...spanning, ...cells("base", 35), ...cells("test", 35)],
    });

    expect(result.threadsSpanningArms).toBe(1);
    expect(result.base).toMatchObject({ threads: 35, usd: 35 });
    expect(result.test).toMatchObject({ threads: 35, usd: 35 });
  });

  it("returns the same verdict for the same input", () => {
    const input = {
      ...base,
      cells: [
        ...cells("base", 40, (i) => ({ usd: noisy(i) })),
        ...cells("test", 40, (i) => ({ usd: 1.05 * noisy(i) + (i % 7) * 0.05 })),
      ],
    };

    expect(run(input)).toEqual(run(input));
  });

  it("resamples a thread with cells in two strata as a whole", () => {
    // A random source stuck on 0 always picks each arm's first thread. Resampling whole threads
    // keeps both of its strata, so the ratio is the mean of 2x and 8x in log space, which is 4.
    const stratum = (model: string, usd: number) => ({ model, usd });
    const spread = (arm: Arm, index: number, aUsd: number, bUsd: number) => [
      cell(arm, index, stratum("model-a", aUsd)),
      cell(arm, index, stratum("model-b", bUsd)),
    ];
    const input: CompareInput = {
      ...base,
      random: () => 0,
      cells: [
        ...spread("base", 0, 1, 1),
        ...spread("test", 0, 2, 8),
        ...Array.from({ length: 34 }, (_, i) => spread("base", i + 1, 1, 1)).flat(),
        ...Array.from({ length: 34 }, (_, i) => spread("test", i + 1, 3, 3)).flat(),
      ],
    };
    const verdict = run(input).usdPerRun;

    expect(verdict).toMatchObject({
      _tag: "changed",
      low: expect.closeTo(4, 5),
      high: expect.closeTo(4, 5),
    });
  });

  it("caps descriptive segments by spend", () => {
    const models = Array.from({ length: 15 }, (_, index) => `model-${index}`);
    const result = run({
      ...base,
      cells: models.flatMap((model, index) => [
        cell("base", index, { model, usd: index + 1 }),
        cell("test", index, { model, usd: index + 1 }),
      ]),
    });

    expect(result.segments).toHaveLength(12);
    expect(result.segments[0]).toMatchObject({ model: "model-14" });
  });
});
