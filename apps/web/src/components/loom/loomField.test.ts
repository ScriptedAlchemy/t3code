import type { LoomLaneActivity } from "@t3tools/client-runtime/projectLoom";
import type { LoomLane, LoomRun, LoomRunActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activityHistogram,
  binTicks,
  isLoomEventMarker,
  laneExtent,
  loomChain,
  tickPaths,
} from "./loomField";
import { loomScale } from "./loomScale";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-22T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function run(id: string, patch: Partial<LoomRun> = {}): LoomRun {
  return {
    id,
    threadId: "lane",
    ordinal: 1,
    status: "completed",
    providerInstanceId: "codex",
    model: "gpt-5",
    userMessageId: "message",
    requestedAt: iso(T0 + 10 * MINUTE),
    startedAt: iso(T0 + 11 * MINUTE),
    completedAt: iso(T0 + 20 * MINUTE),
    ...patch,
  } as LoomRun;
}

const ticks = (runId: string, entries: LoomRunActivity["ticks"]) =>
  ({ runId, threadId: "lane", ticks: entries }) as LoomRunActivity;

const lane = (patch: Partial<LoomLane> = {}) => ({
  createdAt: iso(T0),
  archivedAt: null,
  ...patch,
});

const activity = (patch: Partial<LoomLaneActivity>): LoomLaneActivity => ({
  runs: [],
  markers: [],
  activity: [],
  ...patch,
});

describe("laneExtent", () => {
  it("spans creation to the last completion, tick or marker", () => {
    const extent = laneExtent(
      lane(),
      activity({
        runs: [run("r1")],
        activity: [ticks("r1", [[25 * MINUTE, "agent"]])],
      }),
      T0 + 60 * MINUTE,
    );
    expect(extent).toEqual({ startMs: T0, endMs: T0 + 35 * MINUTE, active: false });
  });

  it("reaches the as-of time while a run is still active", () => {
    const asOf = T0 + 90 * MINUTE;
    const extent = laneExtent(
      lane(),
      activity({ runs: [run("r1", { status: "running", completedAt: null })] }),
      asOf,
    );
    expect(extent).toEqual({ startMs: T0, endMs: asOf, active: true });
  });

  it("stops at the archive time and is no longer active", () => {
    const extent = laneExtent(
      lane({ archivedAt: iso(T0 + 15 * MINUTE) }),
      activity({ runs: [run("r1", { status: "running", completedAt: null })] }),
      T0 + 90 * MINUTE,
    );
    expect(extent).toEqual({ startMs: T0, endMs: T0 + 15 * MINUTE, active: false });
  });

  it("starts at an earlier run than the lane's creation", () => {
    const extent = laneExtent(
      lane({ createdAt: iso(T0 + 30 * MINUTE) }),
      activity({ runs: [run("r1")] }),
      T0 + 90 * MINUTE,
    );
    expect(extent.startMs).toBe(T0 + 10 * MINUTE);
  });
});

describe("binTicks", () => {
  const view = { fromMs: T0, toMs: T0 + 100 * MINUTE };
  const width = 116;
  const scale = loomScale(view, width);
  const runsById = new Map([["r1", run("r1", { requestedAt: iso(T0) })]]);

  it("collapses ticks in one pixel column into one entry with the priority kind", () => {
    const bins = binTicks(
      [
        ticks("r1", [
          [50 * MINUTE, "agent"],
          [50 * MINUTE + 1_000, "edit"],
          [50 * MINUTE + 2_000, "tool"],
          [50 * MINUTE + 3_000, "user"],
        ]),
      ],
      runsById,
      scale,
      width,
    );
    expect(bins).toEqual([{ column: 58, kind: "edit", count: 4 }]);
  });

  it("lets an error outrank every other kind and keeps separate columns apart", () => {
    const bins = binTicks(
      [
        ticks("r1", [
          [10 * MINUTE, "agent"],
          [80 * MINUTE, "edit"],
          [80 * MINUTE, "error"],
        ]),
      ],
      runsById,
      scale,
      width,
    );
    expect(bins.map((bin) => [bin.kind, bin.count])).toEqual([
      ["agent", 1],
      ["error", 2],
    ]);
  });

  it("drops ticks outside the view and ticks whose run is not loaded", () => {
    const bins = binTicks(
      [ticks("r1", [[200 * MINUTE, "edit"]]), ticks("missing", [[5 * MINUTE, "edit"]])],
      runsById,
      scale,
      width,
    );
    expect(bins).toEqual([]);
  });

  it("keeps thousands of ticks to one path per kind", () => {
    const dense = Array.from(
      { length: 4_000 },
      (_, index) => [index * 1_500, index % 2 === 0 ? "agent" : "tool"] as const,
    );
    const bins = binTicks([ticks("r1", dense)], runsById, scale, width);
    const paths = tickPaths(bins, 16, 4);
    expect(bins.length).toBeLessThanOrEqual(width);
    expect(bins.reduce((total, bin) => total + bin.count, 0)).toBe(4_000);
    expect([...paths.keys()]).toEqual(["tool"]);
  });
});

describe("loomChain", () => {
  const node = (threadId: string, parentThreadId: string | null) => ({ threadId, parentThreadId });
  const window = {
    ancestors: [node("grandparent", null)],
    lanes: [
      node("parent", "grandparent"),
      node("selected", "parent"),
      node("sibling", "parent"),
      node("child", "selected"),
      node("grandchild", "child"),
      node("other-root", null),
    ],
  } as never;

  it("holds the lane, its ancestors and its descendants, but not its siblings", () => {
    expect([...loomChain(window, "selected")].toSorted()).toEqual(
      ["child", "grandchild", "grandparent", "parent", "selected"].toSorted(),
    );
  });
});

describe("activityHistogram", () => {
  it("counts run requests and ticks in the bin of their time", () => {
    const bounds = { fromMs: T0, toMs: T0 + 100 * MINUTE };
    const counts = activityHistogram(
      {
        runs: [run("r1", { requestedAt: iso(T0 + 10 * MINUTE) })],
        activity: [
          ticks("r1", [
            [0, "user"],
            [1_000, "agent"],
            [80 * MINUTE, "edit"],
            [500 * MINUTE, "edit"],
          ]),
        ],
      },
      bounds,
      30,
    );
    expect(counts).toHaveLength(10);
    expect(counts[1]).toBe(3);
    expect(counts[9]).toBe(1);
    expect(counts.reduce((total, count) => total + count, 0)).toBe(4);
  });
});

describe("isLoomEventMarker", () => {
  const checkpoint = (fileCount: number, status: "ready" | "error") =>
    ({
      kind: "checkpoint",
      id: "c",
      threadId: "lane",
      runId: null,
      at: iso(T0),
      status,
      fileCount,
      additions: 0,
      deletions: 0,
    }) as const;

  it("leaves out ready checkpoints that changed nothing", () => {
    expect(isLoomEventMarker(checkpoint(0, "ready") as never)).toBe(false);
    expect(isLoomEventMarker(checkpoint(2, "ready") as never)).toBe(true);
    expect(isLoomEventMarker(checkpoint(0, "error") as never)).toBe(true);
  });
});
