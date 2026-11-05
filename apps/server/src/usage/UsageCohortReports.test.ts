import { assert, it } from "@effect/vitest";
import { UsageDay, USAGE_CONTRACT_VERSION, type UsageSummary } from "@t3tools/contracts";
import { EMPTY_TOTALS, type UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { UsageAggregator, type PricedUsage } from "./usageAggregation.ts";
import * as UsageCohortReports from "./UsageCohortReports.ts";
import * as UsageService from "./UsageService.ts";

const INPUT = {
  sinceDay: UsageDay.make("2026-11-01"),
  untilDay: UsageDay.make("2026-11-02"),
  timeZone: "UTC",
} as const;
const AT = Date.parse("2026-11-01T00:30:00Z");

const record = (
  sessionId: string,
  costUsd: number,
  overrides: Partial<UsageRecord> = {},
): UsageRecord => ({
  provider: "codex",
  timestampMs: AT,
  model: "gpt-6.1-sol",
  sessionId,
  totals: { ...EMPTY_TOTALS, uncachedInputTokens: 100, outputTokens: 10 },
  reportedCostUsd: costUsd,
  speed: "standard",
  dedupeKey: null,
  ...overrides,
});

const scanned: ReadonlyArray<readonly [UsageRecord, string | undefined]> = [
  [record("s1", 1), undefined],
  [record("s1", 1), undefined],
  [record("s2", 3), undefined],
  [record("s3", 5, { provider: "claude", model: "claude-opus-5-5" }), undefined],
  [record("nobody", 7), undefined],
  [record("s1", 11, { timestampMs: AT + 3 * 3_600_000 }), undefined],
  [record("s1", 13, { provider: "claude" }), "/home/u/.claude/projects/p/s1/subagents/a.jsonl"],
  [record("", 17), undefined],
];

const layerScanner = Layer.mock(UsageService.UsageService)({
  scanPriced: (input, onPriced: (priced: PricedUsage) => void) =>
    Effect.sync(() => {
      const aggregator = new UsageAggregator({
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        rates: new Map(),
        onPriced,
      });
      for (const [item, path] of scanned) aggregator.add(item, "/dir", path);
      return {
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "2026-11-02T00:00:00.000Z",
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: aggregator.finish().buckets,
        sources: [],
        pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 0 },
        scanDurationMs: 0,
      } satisfies UsageSummary;
    }),
});

const layer = UsageCohortReports.layer.pipe(
  Layer.provideMerge(layerScanner),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const attempt = (
  id: string,
  options: {
    readonly session: string;
    readonly startedAt: string | null;
    readonly instance?: string;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
      attempt_id: id,
      thread_id: `thread-${id}`,
      run_id: `run-${id}`,
      attempt_ordinal: 1,
      root_node_id: `node-${id}`,
      provider: "codex",
      provider_instance_id: options.instance ?? "codex",
      provider_thread_id: `pt-${id}`,
      provider_turn_id: null,
      status: "completed",
      payload_json: JSON.stringify({
        nativeThreadId: options.session,
        startedAt: options.startedAt,
        completedAt: options.startedAt === null ? null : "2026-11-01T01:00:00.000Z",
      }),
    })}`;
  });

const stamp = (id: string, version: string, settings: Record<string, boolean>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO usage_attempt_stamps ${sql.insert({
      attempt_id: id,
      thread_id: `thread-${id}`,
      origin: "user",
      t3_version: version,
      settings_json: JSON.stringify(settings),
    })}`;
  });

it.effect("accounts for every dollar of a scan exactly once", () =>
  Effect.gen(function* () {
    yield* attempt("a1", { session: "s1", startedAt: "2026-11-01T00:00:00.000Z" });
    yield* attempt("a2", { session: "s2", startedAt: "2026-11-01T00:10:00.000Z" });
    yield* attempt("a3", { session: "s3", startedAt: "2026-11-01T00:20:00.000Z" });
    yield* attempt("never-started", { session: "s9", startedAt: null });
    yield* stamp("a1", "0.1.7-nightly.1", { pstackEnabled: false });
    yield* stamp("a2", "0.1.7-nightly.2", { pstackEnabled: true });
    yield* stamp("never-started", "0.1.7-nightly.2", { pstackEnabled: true });
    yield* stamp("orphan", "0.1.7-nightly.3", { pstackEnabled: true });

    const report = yield* (yield* UsageCohortReports.UsageCohortReports).readReport({
      ...INPUT,
      boundaryBuild: "0.1.7-nightly.2",
    });
    const { ledger } = report;

    const unmatchedUsd = ledger.unmatched.reduce((sum, row) => sum + row.usd, 0);
    assert.strictEqual(ledger.totalUsd, 58);
    assert.strictEqual(ledger.attributedUsd + ledger.childWorkUsd + unmatchedUsd, ledger.totalUsd);
    assert.deepStrictEqual(
      {
        attributed: ledger.attributedUsd,
        before: ledger.beforeTrackingUsd,
        child: ledger.childWorkUsd,
      },
      { attributed: 10, before: 5, child: 13 },
    );
    assert.deepStrictEqual(
      ledger.unmatched.map((row) => [row.reason, row.usd]),
      [
        ["no_session_id", 17],
        ["outside_attempt", 11],
        ["no_attempt_here", 7],
      ],
    );
    assert.strictEqual(ledger.stampingSince, "2026-11-01T00:00:00.000Z");
    assert.deepStrictEqual(
      report.builds.map((row) => row.build),
      ["0.1.7-nightly.1", "0.1.7-nightly.2", null],
    );
    const pstack = report.comparisons.find(
      (comparison) =>
        comparison.subject._tag === "experiment" && comparison.subject.key === "pstackEnabled",
    );
    assert.deepStrictEqual(
      [pstack?.base.threads, pstack?.test.threads, pstack?.usdPerRun._tag],
      [1, 1, "not_enough_data"],
    );
    const build = report.comparisons.find((comparison) => comparison.subject._tag === "build");
    assert.strictEqual(build?.assignment, "self_selected");
    assert.deepStrictEqual([build?.base.usd, build?.test.usd], [2, 3]);
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects a window longer than the scan cache keeps", () =>
  Effect.gen(function* () {
    const error = yield* (yield* UsageCohortReports.UsageCohortReports)
      .readReport({ ...INPUT, sinceDay: UsageDay.make("2026-07-01") })
      .pipe(Effect.flip);

    assert.deepStrictEqual([error._tag, error.reason], ["UsageReadError", "invalidWindow"]);
  }).pipe(Effect.provide(layer)),
);
