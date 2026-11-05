import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UsageDay } from "./usage.ts";

/** Matches the usage scan cache's retention, past which transcripts are gone. */
export const USAGE_COHORT_MAX_WINDOW_DAYS = 92;

export const UsageCohortReportInput = Schema.Struct({
  sinceDay: UsageDay,
  untilDay: UsageDay,
  /** IANA zone that turns the day bounds into instants. */
  timeZone: TrimmedNonEmptyString,
  /** Builds first seen before this one are the base arm of the build comparison. */
  boundaryBuild: Schema.optional(TrimmedNonEmptyString),
});
export type UsageCohortReportInput = typeof UsageCohortReportInput.Type;

export const UsageCohortVerdict = Schema.Union([
  Schema.TaggedStruct("not_enough_data", {
    reason: Schema.Literals(["too_few_threads", "interval_too_wide"]),
    threadsPerArmFor15Percent: Schema.NullOr(NonNegativeInt),
    daysAtCurrentRate: Schema.NullOr(NonNegativeInt),
  }),
  Schema.TaggedStruct("no_detectable_change", {
    ratio: Schema.Number,
    low: Schema.Number,
    high: Schema.Number,
  }),
  Schema.TaggedStruct("changed", {
    ratio: Schema.Number,
    low: Schema.Number,
    high: Schema.Number,
  }),
]);
export type UsageCohortVerdict = typeof UsageCohortVerdict.Type;

export const UsageCohortTotals = Schema.Struct({
  threads: NonNegativeInt,
  runs: NonNegativeInt,
  modelCalls: NonNegativeInt,
  promptTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  usd: Schema.Number,
});
export type UsageCohortTotals = typeof UsageCohortTotals.Type;

const UsageCohortSegmentKey = {
  providerInstanceId: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  speed: Schema.Literals(["standard", "fast", "ultrafast"]),
};

export const UsageCohortSegment = Schema.Struct({
  ...UsageCohortSegmentKey,
  ...UsageCohortTotals.fields,
});
export type UsageCohortSegment = typeof UsageCohortSegment.Type;

export const UsageCohortUnmatched = Schema.Struct({
  reason: Schema.Literals(["no_session_id", "no_attempt_here", "outside_attempt"]),
  provider: TrimmedNonEmptyString,
  records: NonNegativeInt,
  usd: Schema.Number,
});
export type UsageCohortUnmatched = typeof UsageCohortUnmatched.Type;

export const UsageCohortComparison = Schema.Struct({
  subject: Schema.Union([
    Schema.TaggedStruct("experiment", {
      key: TrimmedNonEmptyString,
      label: TrimmedNonEmptyString,
      spendsOutsideTranscripts: Schema.Boolean,
    }),
    Schema.TaggedStruct("build", { boundary: TrimmedNonEmptyString }),
  ]),
  assignment: Schema.Literal("self_selected"),
  baseLabel: Schema.String,
  testLabel: Schema.String,
  base: UsageCohortTotals,
  test: UsageCohortTotals,
  threadsSpanningArms: NonNegativeInt,
  promptTokensPerCall: UsageCohortVerdict,
  usdPerRun: UsageCohortVerdict,
  segments: ForwardCompatibleArray(
    Schema.Struct({
      ...UsageCohortSegmentKey,
      base: UsageCohortTotals,
      test: UsageCohortTotals,
    }),
  ),
});
export type UsageCohortComparison = typeof UsageCohortComparison.Type;

export const UsageCohortReport = Schema.Struct({
  readAt: Schema.String,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  timeZone: TrimmedNonEmptyString,
  scanDurationMs: NonNegativeInt,
  intervalConfidence: Schema.Number,
  ledger: Schema.Struct({
    totalUsd: Schema.Number,
    attributedUsd: Schema.Number,
    beforeTrackingUsd: Schema.Number,
    childWorkUsd: Schema.Number,
    excludedOriginUsd: Schema.Number,
    unpricedRecords: NonNegativeInt,
    incompleteSources: NonNegativeInt,
    stampingSince: Schema.NullOr(Schema.String),
    unmatched: ForwardCompatibleArray(UsageCohortUnmatched),
  }),
  builds: ForwardCompatibleArray(
    Schema.Struct({
      build: Schema.NullOr(TrimmedNonEmptyString),
      firstSeenAt: Schema.NullOr(Schema.String),
      segments: ForwardCompatibleArray(UsageCohortSegment),
    }),
  ),
  comparisons: ForwardCompatibleArray(UsageCohortComparison),
});
export type UsageCohortReport = typeof UsageCohortReport.Type;
