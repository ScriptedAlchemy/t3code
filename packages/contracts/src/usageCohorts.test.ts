import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { UsageCohortReport } from "./usageCohorts.ts";

const totals = { threads: 1, runs: 1, modelCalls: 1, promptTokens: 1, outputTokens: 1, usd: 1 };
const notEnough = {
  _tag: "not_enough_data",
  reason: "too_few_threads",
  threadsPerArmFor15Percent: null,
  daysAtCurrentRate: null,
};
const comparison = {
  subject: { _tag: "build", boundary: "0.1.8" },
  assignment: "self_selected",
  baseLabel: "Before",
  testLabel: "After",
  base: totals,
  test: totals,
  threadsSpanningArms: 0,
  promptTokensPerCall: notEnough,
  usdPerRun: notEnough,
  segments: [],
};
const report = {
  readAt: "2026-11-05T00:00:00.000Z",
  sinceDay: "2026-11-01",
  untilDay: "2026-11-05",
  timeZone: "UTC",
  scanDurationMs: 1,
  intervalConfidence: 0.998,
  ledger: {
    totalUsd: 1,
    attributedUsd: 1,
    beforeTrackingUsd: 0,
    childWorkUsd: 0,
    excludedOriginUsd: 0,
    unpricedRecords: 0,
    incompleteSources: 0,
    stampingSince: null,
    unmatched: [],
  },
  builds: [],
  comparisons: [comparison],
};

const decode = Schema.decodeUnknownSync(UsageCohortReport);

describe("UsageCohortReport across client and server versions", () => {
  it("accepts a server that retuned its interval", () => {
    expect(decode({ ...report, intervalConfidence: 0.95 }).comparisons).toHaveLength(1);
  });

  it.each([
    ["assignment", { ...comparison, assignment: "randomized" }],
    ["verdict", { ...comparison, usdPerRun: { _tag: "some_new_verdict" } }],
  ])("keeps the report when one comparison has an unknown %s", (_name, unknown) => {
    expect(decode({ ...report, comparisons: [unknown, comparison] }).comparisons).toHaveLength(1);
  });

  it("keeps the report when one unmatched row has an unknown reason", () => {
    const row = { provider: "codex", records: 1, usd: 1 };
    const decoded = decode({
      ...report,
      ledger: {
        ...report.ledger,
        unmatched: [
          { ...row, reason: "some_new_reason" },
          { ...row, reason: "outside_attempt" },
        ],
      },
    });
    expect(decoded.ledger.unmatched).toHaveLength(1);
  });
});
