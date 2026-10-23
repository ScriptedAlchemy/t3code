import { ProviderInstanceId, ThreadId, type LoomLane } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildLoomRows } from "./index.ts";

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
