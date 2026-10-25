import type { LoomLaneActivity } from "@t3tools/client-runtime/projectLoom";
import type { LoomEdge, LoomLane, LoomMarker, LoomRun, LoomWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWeave,
  isLoomEventMarker,
  laneExtent,
  spineWorkstream,
  strandColors,
} from "./loomWeave";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-22T12:00:00.000Z");
export const iso = (ms: number) => new Date(ms).toISOString();

export function run(
  id: string,
  patch: Partial<Omit<LoomRun, "threadId">> & { readonly threadId?: string } = {},
): LoomRun {
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

export const lane = (threadId: string, parent: string | null, patch: Partial<LoomLane> = {}) =>
  ({
    threadId,
    title: threadId,
    relationship: parent === null ? "root" : "subagent",
    parentThreadId: parent,
    providerInstanceId: "codex",
    model: "gpt-5",
    branch: null,
    createdAt: iso(T0),
    archivedAt: null,
    ...patch,
  }) as LoomLane;

export const checkpoint = (
  threadId: string,
  ms: number,
  fileCount: number,
  status: "ready" | "error" = "ready",
) =>
  ({
    kind: "checkpoint",
    id: `cp-${threadId}-${ms}`,
    threadId,
    runId: null,
    at: iso(ms),
    status,
    fileCount,
    additions: 0,
    deletions: 0,
  }) as LoomMarker;

export const edge = (
  type: LoomEdge["type"],
  source: string,
  target: string,
  ms: number,
): LoomEdge =>
  ({
    id: `${type}:${source}:${target}`,
    type,
    sourceThreadId: source,
    targetThreadId: target,
    sourceRunId: null,
    targetRunId: null,
    at: iso(ms),
    status: "completed",
  }) as LoomEdge;

export function window(patch: Partial<LoomWindow>): LoomWindow {
  return {
    projectId: "project",
    asOf: iso(T0 + 120 * MINUTE),
    from: iso(T0 - 60 * MINUTE),
    to: iso(T0 + 120 * MINUTE),
    lanes: [],
    ancestors: [],
    runs: [],
    markers: [],
    edges: [],
    activity: [],
    truncated: {
      lanes: false,
      ancestors: false,
      runs: false,
      markers: false,
      edges: false,
      activity: false,
      bytes: false,
    },
    coverage: {
      untimedTasks: 0,
      untimedTasksTruncated: false,
      commandsScanned: 0,
      commandsTruncated: false,
    },
    nextCursor: null,
    ...patch,
  } as LoomWindow;
}

const activity = (patch: Partial<LoomLaneActivity>): LoomLaneActivity => ({
  runs: [],
  markers: [],
  activity: [],
  ...patch,
});

describe("laneExtent", () => {
  const created = { createdAt: iso(T0), archivedAt: null };

  it("spans creation to the last completion, tick or marker", () => {
    const extent = laneExtent(
      created,
      activity({
        runs: [run("r1")],
        activity: [{ runId: "r1", threadId: "lane", ticks: [[25 * MINUTE, "agent"]] } as never],
      }),
      T0 + 60 * MINUTE,
    );
    expect(extent).toEqual({ startMs: T0, endMs: T0 + 35 * MINUTE, active: false });
  });

  it("reaches the as-of time while a run is still active", () => {
    const asOf = T0 + 90 * MINUTE;
    const extent = laneExtent(
      created,
      activity({ runs: [run("r1", { status: "running", completedAt: null })] }),
      asOf,
    );
    expect(extent).toEqual({ startMs: T0, endMs: asOf, active: true });
  });

  it("stops at the archive time and is no longer active", () => {
    const extent = laneExtent(
      { createdAt: iso(T0), archivedAt: iso(T0 + 15 * MINUTE) },
      activity({ runs: [run("r1", { status: "running", completedAt: null })] }),
      T0 + 90 * MINUTE,
    );
    expect(extent).toEqual({ startMs: T0, endMs: T0 + 15 * MINUTE, active: false });
  });

  it("starts at an earlier run than the lane's creation", () => {
    const extent = laneExtent(
      { createdAt: iso(T0 + 30 * MINUTE), archivedAt: null },
      activity({ runs: [run("r1")] }),
      T0 + 90 * MINUTE,
    );
    expect(extent.startMs).toBe(T0 + 10 * MINUTE);
  });
});

describe("isLoomEventMarker", () => {
  it("leaves out ready checkpoints that changed nothing", () => {
    expect(isLoomEventMarker(checkpoint("lane", T0, 0))).toBe(false);
    expect(isLoomEventMarker(checkpoint("lane", T0, 2))).toBe(true);
    expect(isLoomEventMarker(checkpoint("lane", T0, 0, "error"))).toBe(true);
  });
});

describe("buildWeave", () => {
  const data = window({
    lanes: [
      lane("old-root", null),
      lane("root", null, { createdAt: iso(T0 + 5 * MINUTE) }),
      lane("exact-child", "root", { createdAt: iso(T0 + 12 * MINUTE) }),
      lane("inferred-child", "root", { createdAt: iso(T0 + 14 * MINUTE) }),
      lane("grandchild", "exact-child", { createdAt: iso(T0 + 16 * MINUTE) }),
    ],
    runs: [
      run("old", { threadId: "old-root", requestedAt: iso(T0), completedAt: iso(T0 + MINUTE) }),
      run("r1", { threadId: "root" }),
      run("r2", {
        threadId: "root",
        ordinal: 2,
        status: "failed",
        requestedAt: iso(T0 + 30 * MINUTE),
        startedAt: iso(T0 + 31 * MINUTE),
        completedAt: iso(T0 + 40 * MINUTE),
      }),
      run("c1", {
        threadId: "exact-child",
        requestedAt: iso(T0 + 13 * MINUTE),
        startedAt: iso(T0 + 13 * MINUTE),
        completedAt: iso(T0 + 18 * MINUTE),
      }),
    ],
    markers: [
      checkpoint("root", T0 + 20 * MINUTE, 0),
      checkpoint("root", T0 + 21 * MINUTE, 3),
      {
        kind: "test_command",
        id: "t1",
        threadId: "root",
        runId: "r1",
        at: iso(T0 + 19 * MINUTE),
        completedAt: iso(T0 + 19 * MINUTE + 5_000),
        command: "vp test run",
        exitCode: 1,
      } as LoomMarker,
    ],
    edges: [
      edge("subagent_spawn", "root", "exact-child", T0 + 12 * MINUTE + 30_000),
      edge("subagent_result", "exact-child", "root", T0 + 18 * MINUTE + 30_000),
    ],
    activity: [
      {
        runId: "r1",
        threadId: "root",
        ticks: [
          [MINUTE, "user"],
          [2 * MINUTE, "edit"],
          [3 * MINUTE, "error"],
        ],
      } as never,
    ],
  });
  const weave = buildWeave(data);
  const root = weave.strands.get("root")!;

  it("orders workstreams by their last activity and colours them in that order", () => {
    expect(weave.workstreams.map((w) => [w.rootId, w.colorIndex])).toEqual([
      ["root", 0],
      ["old-root", 1],
    ]);
    expect(weave.workstreams[0]!.strands.map((s) => s.threadId)).toEqual([
      "root",
      "exact-child",
      "grandchild",
      "inferred-child",
    ]);
  });

  it("counts agents, runs and failures per workstream", () => {
    const [busy, old] = weave.workstreams;
    expect(busy).toMatchObject({ agentCount: 3, runCount: 3, failureCount: 2 });
    expect(old).toMatchObject({ agentCount: 0, runCount: 1, failureCount: 0 });
  });

  it("places a spawn exactly from its edge and otherwise infers it from creation", () => {
    expect(weave.strands.get("exact-child")!.spawn).toEqual({
      ms: T0 + 12 * MINUTE + 30_000,
      exact: true,
    });
    expect(weave.strands.get("inferred-child")!.spawn).toEqual({
      ms: T0 + 14 * MINUTE,
      exact: false,
    });
    expect(root.spawn).toBeNull();
  });

  it("records a rejoin only when an edge returns to the parent", () => {
    expect(weave.strands.get("exact-child")!.rejoin).toMatchObject({
      ms: T0 + 18 * MINUTE + 30_000,
    });
    expect(weave.strands.get("inferred-child")!.rejoin).toBeNull();
  });

  it("ends each strand by its latest run", () => {
    expect(root.end).toBe("failed");
    expect(weave.strands.get("exact-child")!.end).toBe("completed");
    expect(weave.strands.get("inferred-child")!.end).toBe("unknown");
  });

  it("lists events oldest first, skipping empty checkpoints and marking failures", () => {
    expect(root.events.map((event) => [event.kind, event.failed])).toEqual([
      ["run", false],
      ["user", false],
      ["edit", false],
      ["error", true],
      ["test", true],
      ["checkpoint", false],
      ["run", false],
      ["error", true],
    ]);
    expect(root.events.at(-1)!.ms).toBe(T0 + 40 * MINUTE);
    expect(root.events[1]!.selection).toEqual({ kind: "lane", id: "root" });
  });

  it("spans a runless subagent from its recorded spawn to its recorded result", () => {
    const native = buildWeave(
      window({
        lanes: [
          lane("root", null),
          lane("native", "root", { createdAt: iso(T0 + 2 * MINUTE) }),
          lane("unrecorded", "root", { createdAt: iso(T0 + 3 * MINUTE) }),
        ],
        edges: [
          edge("subagent_spawn", "root", "native", T0 + 2 * MINUTE),
          edge("subagent_result", "native", "root", T0 + 9 * MINUTE),
        ],
      }),
    );
    expect(native.strands.get("native")!.extent).toMatchObject({
      startMs: T0 + 2 * MINUTE,
      endMs: T0 + 9 * MINUTE,
    });
    expect(native.strands.get("unrecorded")!.extent).toMatchObject({
      startMs: T0 + 3 * MINUTE,
      endMs: T0 + 3 * MINUTE,
    });
  });

  it("ends the loaded tail at the window's end when the as-of time is later", () => {
    expect(weave.tailMs).toBe(Math.min(Date.parse(data.asOf), Date.parse(data.to)));
    const late = buildWeave({ ...data, to: iso(T0 + 50 * MINUTE), asOf: iso(T0 + 90 * MINUTE) });
    expect(late.tailMs).toBe(T0 + 50 * MINUTE);
  });

  it("colours the spine's branches apart and every other workstream as one", () => {
    const colors = strandColors(weave, weave.workstreams[0]!);
    expect(colors.get("root")).toBe(0);
    expect(colors.get("exact-child")).toBe(1);
    expect(colors.get("grandchild")).toBe(1);
    expect(colors.get("inferred-child")).toBe(2);
    expect(colors.get("old-root")).toBe(1);
    const other = strandColors(weave, weave.workstreams[1]!);
    expect(new Set(["root", "exact-child", "inferred-child"].map((id) => other.get(id)))).toEqual(
      new Set([0]),
    );
  });

  it("preserves nested ancestry when only the descendant is on this page", () => {
    const paged = buildWeave(
      window({
        lanes: [lane("grandchild", "child")],
        ancestors: [lane("root", null), lane("child", "root")],
        runs: [run("grandchild-run", { threadId: "grandchild" })],
      }),
    );
    const workstream = paged.workstreams[0]!;
    expect(
      workstream.strands.map(({ threadId, parentThreadId, depth }) => [
        threadId,
        parentThreadId,
        depth,
      ]),
    ).toEqual([
      ["root", null, 0],
      ["child", "root", 1],
      ["grandchild", "child", 2],
    ]);
    const colors = strandColors(paged, workstream);
    expect(colors.get("child")).not.toBe(colors.get("root"));
    expect(colors.get("grandchild")).toBe(colors.get("child"));
  });

  it("puts the requested workstream on the spine, or the most recent one", () => {
    expect(spineWorkstream(weave, "old-root")?.rootId).toBe("old-root");
    expect(spineWorkstream(weave, "missing")?.rootId).toBe("root");
    expect(spineWorkstream(weave, undefined)?.rootId).toBe("root");
  });
});
