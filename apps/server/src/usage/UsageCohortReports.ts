import {
  USAGE_COHORT_MAX_WINDOW_DAYS,
  UsageReadError,
  type UsageCohortComparison,
  type UsageCohortReport,
  type UsageCohortReportInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { readAttempts, readBuildFirstSeen } from "./UsageAttemptStamps.ts";
import * as UsageService from "./UsageService.ts";
import { compareArms, type CompareInput } from "./usageCohortCompare.ts";
import {
  buildRows,
  comparisonCells,
  makeCohortScan,
  type Arm,
  type AttemptStamp,
} from "./usageCohortJoin.ts";
import { USAGE_EXPERIMENTS, type UsageExperimentDefinition } from "./usageExperiments.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
// An attempt older than this loses its records to "no_attempt_here", which the ledger shows.
const ATTEMPT_LOOKBACK_MS = 30 * DAY_MS;

export class UsageCohortReports extends Context.Service<
  UsageCohortReports,
  {
    readonly readReport: (
      input: UsageCohortReportInput,
    ) => Effect.Effect<UsageCohortReport, UsageReadError>;
  }
>()("t3/usage/UsageCohortReports") {}

const invalidWindow = (detail: string) => new UsageReadError({ reason: "invalidWindow", detail });

const dayStartMs = (day: string) =>
  Option.map(DateTime.make(`${day}T00:00:00Z`), DateTime.toEpochMillis);

const compareCohort = Effect.fn("UsageCohortReports.compare")(function* (input: CompareInput) {
  const steps = compareArms(input);
  let step = steps.next();
  while (!step.done) {
    yield* Effect.yieldNow;
    step = steps.next();
  }
  const result = step.value;
  const empty =
    result.base.threads === 0 && result.test.threads === 0 && result.threadsSpanningArms === 0;
  return empty ? null : result;
});

export const layer = Layer.effect(
  UsageCohortReports,
  Effect.gen(function* () {
    const usage = yield* UsageService.UsageService;
    const sql = yield* SqlClient.SqlClient;
    const oneAtATime = yield* Semaphore.make(1);

    const readReport = Effect.fn("UsageCohortReports.readReport")(
      function* (input: UsageCohortReportInput) {
        const sinceMs = dayStartMs(input.sinceDay);
        const untilMs = dayStartMs(input.untilDay);
        if (Option.isNone(sinceMs) || Option.isNone(untilMs) || sinceMs.value > untilMs.value) {
          return yield* invalidWindow("Cohort report needs valid days, in order.");
        }
        const windowDays = Math.round((untilMs.value - sinceMs.value) / DAY_MS) + 1;
        if (windowDays > USAGE_COHORT_MAX_WINDOW_DAYS) {
          return yield* invalidWindow(
            `Cohort report window must be at most ${USAGE_COHORT_MAX_WINDOW_DAYS} days.`,
          );
        }

        const history = yield* Effect.all([
          readAttempts(sql, {
            sinceMs: sinceMs.value - DAY_MS - ATTEMPT_LOOKBACK_MS,
            untilMs: untilMs.value + 2 * DAY_MS,
          }),
          readBuildFirstSeen(sql),
        ]).pipe(
          Effect.mapError(
            (cause) =>
              new UsageReadError({
                reason: "scanFailed",
                detail: "Run attempt history could not be read.",
                cause,
              }),
          ),
        );
        const [attempts, firstSeenAtMs] = history;

        const scan = makeCohortScan(attempts);
        const summary = yield* usage.scanPriced(
          {
            sinceDay: input.sinceDay,
            untilDay: input.untilDay,
            timeZone: input.timeZone,
            awaitRefresh: true,
          },
          scan.add,
        );
        const { ledger, cells } = scan.finish();

        const compare = (key: string, armOf: (stamp: AttemptStamp) => Arm | null) =>
          compareCohort({ key, windowDays, cells: comparisonCells(cells, armOf) });

        const comparisons: UsageCohortComparison[] = [];
        for (const [key, definition] of Object.entries<UsageExperimentDefinition>(
          USAGE_EXPERIMENTS,
        )) {
          const result = yield* compare(`experiment:${key}`, ({ settings }) => {
            const value = settings[key];
            return value === undefined ? null : value ? "test" : "base";
          });
          if (result === null) continue;
          comparisons.push({
            subject: {
              _tag: "experiment",
              key,
              label: definition.label,
              spendsOutsideTranscripts: definition.spendsOutsideTranscripts === true,
            },
            assignment: "self_selected",
            baseLabel: "Off",
            testLabel: "On",
            ...result,
          });
        }
        const boundaryMs =
          input.boundaryBuild === undefined ? undefined : firstSeenAtMs.get(input.boundaryBuild);
        if (input.boundaryBuild !== undefined && boundaryMs !== undefined) {
          const result = yield* compare(`build:${input.boundaryBuild}`, ({ t3Version }) => {
            const seen = firstSeenAtMs.get(t3Version);
            return seen === undefined ? null : seen < boundaryMs ? "base" : "test";
          });
          if (result !== null) {
            comparisons.push({
              subject: { _tag: "build", boundary: input.boundaryBuild },
              assignment: "self_selected",
              baseLabel: `Before ${input.boundaryBuild}`,
              testLabel: `${input.boundaryBuild} and later`,
              ...result,
            });
          }
        }

        const stampingSince = firstSeenAtMs.size === 0 ? null : Math.min(...firstSeenAtMs.values());
        return {
          readAt: summary.readAt,
          sinceDay: input.sinceDay,
          untilDay: input.untilDay,
          timeZone: input.timeZone,
          scanDurationMs: summary.scanDurationMs,
          intervalConfidence: 0.998,
          ledger: {
            ...ledger,
            incompleteSources: summary.sources.filter(
              (source) =>
                source.status === "partial" ||
                source.status === "failed" ||
                source.refreshing === true,
            ).length,
            stampingSince:
              stampingSince === null
                ? null
                : DateTime.formatIso(DateTime.makeUnsafe(stampingSince)),
          },
          builds: buildRows(cells, firstSeenAtMs),
          comparisons,
        } satisfies UsageCohortReport;
      },
      (effect) => effect.pipe(oneAtATime.withPermits(1)),
    );

    return { readReport };
  }),
);
