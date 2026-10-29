import {
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ThreadId,
  type LoomLane,
  type LoomMarker,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildLoomRows, loomCoverageNotes, loomMarkerThreadRef } from "./index.ts";

const lane = (id: string, parent: string | null, createdAt: string): LoomLane => ({
  threadId: ThreadId.make(id),
  title: `Lane ${id}`,
  relationship: parent === null ? "root" : "subagent",
  parentThreadId: parent === null ? null : ThreadId.make(parent),
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
  branch: null,
  createdAt,
  archivedAt: null,
});

const window = {
  lanes: [
    lane("root", null, "2026-10-20T00:00:00.000Z"),
    lane("late-child", "root", "2026-10-20T02:00:00.000Z"),
    lane("early-child", "root", "2026-10-20T01:00:00.000Z"),
    lane("grandchild", "early-child", "2026-10-20T03:00:00.000Z"),
    lane("orphan", "deleted", "2026-10-20T04:00:00.000Z"),
  ],
  ancestors: [],
};
const ids = (rows: ReturnType<typeof buildLoomRows>) => rows.map((row) => row.threadId);

describe("buildLoomRows", () => {
  it("keeps a remote parent's identity on ancestor rows without nesting under a colliding local id", () => {
    const delegatedFrom = {
      environmentId: EnvironmentId.make("another-environment"),
      threadId: ThreadId.make("root"),
      title: "Remote parent",
    };
    const rows = buildLoomRows(
      {
        lanes: [window.lanes[0]!, lane("fork", "remote-worker", "2026-10-20T02:00:00.000Z")],
        ancestors: [
          {
            threadId: ThreadId.make("remote-worker"),
            title: "Worker",
            relationship: "subagent",
            parentThreadId: null,
            delegatedFrom,
          },
        ],
      },
      new Set(),
    );
    expect(rows.map((row) => [row.threadId, row.depth])).toEqual([
      ["root", 0],
      ["remote-worker", 0],
      ["fork", 1],
    ]);
    expect(rows[1]).toMatchObject({ delegatedFrom, lane: null, parentMissing: false });
  });

  it("nests children oldest first and marks a parent that is not loaded", () => {
    const rows = buildLoomRows(window, new Set());
    expect(ids(rows)).toEqual(["root", "early-child", "grandchild", "late-child", "orphan"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 1, 0]);
    expect(rows.find((row) => row.threadId === "orphan")?.parentMissing).toBe(true);
  });

  it("hides a collapsed lane's descendants and counts them", () => {
    const rows = buildLoomRows(window, new Set(["root"]));
    expect(ids(rows)).toEqual(["root", "orphan"]);
    expect(rows[0]).toMatchObject({ collapsed: true, hiddenCount: 3 });
  });

  it("keeps the ancestry of a search match and opens collapsed lanes on the way", () => {
    const rows = buildLoomRows(window, new Set(["root"]), "grandchild");
    expect(ids(rows)).toEqual(["root", "early-child", "grandchild"]);
  });
});

it("opens remote tasks in their owning environment while native tasks stay on their lane", () => {
  const environmentId = EnvironmentId.make("here");
  const marker: LoomMarker = {
    kind: "subagent_task",
    id: NodeId.make("task"),
    threadId: ThreadId.make("thread"),
    runId: null,
    at: "2026-10-20T02:00:00.000Z",
    completedAt: null,
    status: "running",
    title: "Task",
  };
  expect(loomMarkerThreadRef(environmentId, marker)).toEqual({ environmentId, threadId: "thread" });
  expect(
    loomMarkerThreadRef(environmentId, {
      ...marker,
      remoteChild: {
        environmentId: EnvironmentId.make("there"),
        threadId: ThreadId.make("thread"),
        label: "Build server",
      },
    }),
  ).toEqual({ environmentId: "there", threadId: "thread" });
});

describe("loomCoverageNotes", () => {
  it("names a capped command scan and says when the untimed count is only a bound", () => {
    expect(
      loomCoverageNotes({
        coverage: {
          untimedTasks: 1_000,
          untimedTasksTruncated: true,
          commandsScanned: 4_000,
          commandsTruncated: true,
        },
      }),
    ).toEqual([
      "test commands from the newest 4000 commands only",
      "more than 1000 agent tasks with no recorded time, not shown",
    ]);
    expect(
      loomCoverageNotes({
        coverage: {
          untimedTasks: 0,
          untimedTasksTruncated: false,
          commandsScanned: 12,
          commandsTruncated: false,
        },
      }),
    ).toEqual([]);
  });
});
