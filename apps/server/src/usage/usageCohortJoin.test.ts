import { describe, expect, it } from "@effect/vitest";
import { EMPTY_TOTALS, type UsageRecord } from "@t3tools/provider-core/server/usage";

import {
  attribute,
  buildRows,
  comparisonCells,
  indexAttemptsBySession,
  makeCohortScan,
  type AttemptRow,
  type AttemptStamp,
} from "./usageCohortJoin.ts";

const T0 = Date.parse("2026-11-01T00:00:00Z");
const HOUR = 3_600_000;

const stamp = (overrides: Partial<AttemptStamp> = {}): AttemptStamp => ({
  origin: "user",
  t3Version: "0.1.7-nightly.20261102.72",
  settings: {},
  ...overrides,
});

const attempt = (overrides: Partial<AttemptRow> = {}): AttemptRow => ({
  attemptId: "attempt-1",
  runId: "run-1",
  threadId: "thread-1",
  sessionId: "session-a",
  providerInstanceId: "codex",
  startedAtMs: T0,
  endedAtMs: T0 + HOUR,
  stamp: stamp(),
  ...overrides,
});

const usage = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  provider: "codex",
  timestampMs: T0 + HOUR / 2,
  model: "gpt-6.1-sol",
  sessionId: "session-a",
  totals: { ...EMPTY_TOTALS, uncachedInputTokens: 100, cachedInputTokens: 900, outputTokens: 10 },
  reportedCostUsd: null,
  speed: "standard",
  dedupeKey: null,
  ...overrides,
});

const priced = (record: UsageRecord, costUsd = 1, transcriptPath?: string, unpriced = false) => ({
  record,
  costUsd,
  unpriced,
  transcriptPath,
});

describe("attribute", () => {
  const first = attempt({ attemptId: "first", startedAtMs: T0, endedAtMs: T0 + HOUR });
  const second = attempt({
    attemptId: "second",
    startedAtMs: T0 + 2 * HOUR,
    endedAtMs: null,
    stamp: null,
  });
  const index = indexAttemptsBySession([second, first]);

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly record: Partial<UsageRecord>;
    readonly path?: string;
    readonly expected: unknown;
  }> = [
    {
      name: "a running attempt with no end owns later records",
      record: { timestampMs: T0 + 90 * HOUR },
      expected: { _tag: "attempt", attempt: second },
    },
    {
      name: "a record inside a finished attempt belongs to it",
      record: { timestampMs: T0 + HOUR },
      expected: { _tag: "attempt", attempt: first },
    },
    {
      name: "a record after an attempt ended and before the next started is outside",
      record: { timestampMs: T0 + HOUR + 1 },
      expected: { _tag: "unmatched", reason: "outside_attempt" },
    },
    {
      name: "a record before the first attempt on its session is outside",
      record: { timestampMs: T0 - 1 },
      expected: { _tag: "unmatched", reason: "outside_attempt" },
    },
    {
      name: "a session this environment never ran has no attempt here",
      record: { sessionId: "other" },
      expected: { _tag: "unmatched", reason: "no_attempt_here" },
    },
    {
      name: "an empty session id cannot be matched",
      record: { sessionId: "" },
      expected: { _tag: "unmatched", reason: "no_session_id" },
    },
    {
      name: "a Claude subagent transcript is child work even when its session matches",
      record: { provider: "claude" },
      path: "/home/u/.claude/projects/p/session-a/subagents/agent-1.jsonl",
      expected: { _tag: "child_work" },
    },
    {
      name: "a Claude subagent transcript on Windows is child work",
      record: { provider: "claude" },
      path: "C:\\Users\\u\\.claude\\projects\\p\\session-a\\subagents\\agent-1.jsonl",
      expected: { _tag: "child_work" },
    },
    {
      name: "a Codex transcript under a directory named subagents is still matched",
      record: {},
      path: "/home/u/.codex/sessions/subagents/rollout.jsonl",
      expected: { _tag: "attempt", attempt: first },
    },
  ];

  it.each(cases)("$name", ({ record, path, expected }) => {
    expect(attribute(index, usage(record), path)).toEqual(expected);
  });
});

describe("makeCohortScan", () => {
  it("keeps a null stamp null after a stamped attempt on the same session", () => {
    const stamped = attempt({ attemptId: "stamped", endedAtMs: T0 + HOUR });
    const unstamped = attempt({
      attemptId: "unstamped",
      startedAtMs: T0 + 2 * HOUR,
      endedAtMs: null,
      stamp: null,
    });
    const scan = makeCohortScan([stamped, unstamped]);
    scan.add(priced(usage({ timestampMs: T0 + 3 * HOUR }), 4));
    const { ledger, cells } = scan.finish();

    expect(cells.map((cell) => cell.attempt.attemptId)).toEqual(["unstamped"]);
    expect(ledger).toMatchObject({ attributedUsd: 4, beforeTrackingUsd: 4 });
  });

  it("puts every record in exactly one ledger bucket", () => {
    const scheduled = attempt({
      attemptId: "scheduled",
      sessionId: "session-s",
      stamp: stamp({ origin: "scheduled" }),
    });
    const scan = makeCohortScan([attempt(), scheduled]);
    scan.add(priced(usage(), 1));
    scan.add(priced(usage({ sessionId: "session-s" }), 2));
    scan.add(priced(usage({ sessionId: "nobody" }), 3, undefined, true));
    scan.add(priced(usage({ timestampMs: T0 + 5 * HOUR }), 5));
    scan.add(priced(usage({ provider: "claude" }), 7, "/x/subagents/a.jsonl"));
    const { ledger } = scan.finish();

    expect(ledger).toMatchObject({
      totalUsd: 18,
      attributedUsd: 3,
      childWorkUsd: 7,
      excludedOriginUsd: 2,
      beforeTrackingUsd: 0,
      unpricedRecords: 1,
    });
    expect(ledger.unmatched).toEqual([
      { reason: "outside_attempt", provider: "codex", records: 1, usd: 5 },
      { reason: "no_attempt_here", provider: "codex", records: 1, usd: 3 },
    ]);
    const unmatchedUsd = ledger.unmatched.reduce((sum, row) => sum + row.usd, 0);
    expect(ledger.attributedUsd + ledger.childWorkUsd + unmatchedUsd).toBe(ledger.totalUsd);
  });
});

describe("comparisonCells", () => {
  const scanOf = (attempts: readonly AttemptRow[], records: readonly UsageRecord[]) => {
    const scan = makeCohortScan(attempts);
    for (const record of records) scan.add(priced(record, 1));
    return scan.finish().cells;
  };
  const enabled = (settings: AttemptStamp["settings"]) => (settings.flag ? "test" : "base");

  it("keeps only user and agent origins on Claude and Codex, and counts runs once", () => {
    const cells = scanOf(
      [
        attempt({ attemptId: "a1", runId: "r1" }),
        attempt({ attemptId: "a2", runId: "r1", startedAtMs: T0 + 2 * HOUR, endedAtMs: null }),
        attempt({
          attemptId: "ghost",
          sessionId: "s-ghost",
          stamp: stamp({ origin: "scheduled" }),
        }),
        attempt({ attemptId: "old", sessionId: "s-old", stamp: null }),
        attempt({ attemptId: "oc", sessionId: "s-oc" }),
      ],
      [
        usage({ timestampMs: T0 + 1 }),
        usage({ timestampMs: T0 + 3 * HOUR }),
        usage({ sessionId: "s-ghost" }),
        usage({ sessionId: "s-old" }),
        usage({ sessionId: "s-oc", provider: "opencode" }),
      ],
    );
    const compared = comparisonCells(cells, (s) => enabled(s.settings));

    expect(compared).toHaveLength(1);
    expect(compared[0]).toMatchObject({ modelCalls: 2, usd: 2, arm: "base" });
    expect(compared[0]!.runIds).toHaveLength(1);
  });

  it("assigns arms from the stamp and leaves out attempts that belong to neither", () => {
    const cells = scanOf(
      [
        attempt({ attemptId: "on", threadId: "t-on", stamp: stamp({ settings: { flag: true } }) }),
        attempt({
          attemptId: "off",
          threadId: "t-off",
          sessionId: "s-off",
          stamp: stamp({ settings: { flag: false } }),
        }),
        attempt({ attemptId: "none", threadId: "t-none", sessionId: "s-none" }),
      ],
      [usage(), usage({ sessionId: "s-off" }), usage({ sessionId: "s-none" })],
    );
    const compared = comparisonCells(cells, ({ settings }) =>
      settings.flag === undefined ? null : settings.flag ? "test" : "base",
    );

    expect(compared.map((cell) => [cell.threadId, cell.arm]).toSorted()).toEqual([
      ["t-off", "base"],
      ["t-on", "test"],
    ]);
  });
});

describe("buildRows", () => {
  it("orders builds by first seen, puts untracked spend last, and counts threads and runs", () => {
    const attempts = [
      attempt({
        attemptId: "a",
        threadId: "t1",
        runId: "r1",
        stamp: stamp({ t3Version: "0.1.8-b" }),
      }),
      attempt({
        attemptId: "b",
        sessionId: "s2",
        threadId: "t2",
        runId: "r2",
        stamp: stamp({ t3Version: "0.1.7-z" }),
      }),
      attempt({
        attemptId: "c",
        sessionId: "s3",
        threadId: "t2",
        runId: "r3",
        stamp: stamp({ t3Version: "0.1.7-z" }),
      }),
      attempt({ attemptId: "d", sessionId: "s4", threadId: "t4", stamp: null }),
    ];
    const scan = makeCohortScan(attempts);
    for (const sessionId of ["session-a", "s2", "s3", "s4"]) {
      scan.add(priced(usage({ sessionId }), 2));
    }
    const rows = buildRows(
      scan.finish().cells,
      new Map([
        ["0.1.8-b", T0 + 5 * HOUR],
        ["0.1.7-z", T0 + HOUR],
      ]),
    );

    expect(rows.map((row) => row.build)).toEqual(["0.1.7-z", "0.1.8-b", null]);
    expect(rows[0]).toMatchObject({ firstSeenAt: "2026-11-01T01:00:00.000Z" });
    expect(rows[0]!.segments[0]).toMatchObject({ threads: 1, runs: 2, usd: 4, modelCalls: 2 });
    expect(rows[2]).toMatchObject({ firstSeenAt: null });
  });
});
