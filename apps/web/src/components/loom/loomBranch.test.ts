import { describe, expect, it } from "vite-plus/test";

import {
  BRANCH_LANE_SPACING,
  BRANCH_MARGIN,
  BRANCH_RUN,
  branchLayout,
  branchSegments,
  clusterEvents,
  workstreamNodes,
} from "./loomBranch";
import { buildWeave, type WeaveEvent } from "./loomWeave";
import { edge, iso, lane, run, window } from "./loomWeave.test";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-22T12:00:00.000Z");
const x = (ms: number) => (ms - T0) / MINUTE;

const weave = buildWeave(
  window({
    lanes: [
      lane("root", null),
      lane("second", "root", { createdAt: iso(T0 + 20 * MINUTE) }),
      lane("first", "root", { createdAt: iso(T0 + 10 * MINUTE) }),
      lane("first-child", "first", { createdAt: iso(T0 + 12 * MINUTE) }),
      lane("third", "root", { createdAt: iso(T0 + 30 * MINUTE) }),
    ],
    runs: [
      run("r", { threadId: "root", requestedAt: iso(T0), completedAt: iso(T0 + 60 * MINUTE) }),
      run("f", {
        threadId: "first",
        requestedAt: iso(T0 + 10 * MINUTE),
        completedAt: iso(T0 + 40 * MINUTE),
      }),
      run("s", {
        threadId: "second",
        requestedAt: iso(T0 + 20 * MINUTE),
        completedAt: iso(T0 + 25 * MINUTE),
      }),
    ],
    edges: [
      edge("subagent_spawn", "root", "first", T0 + 10 * MINUTE),
      edge("subagent_result", "first", "root", T0 + 50 * MINUTE),
    ],
  }),
);
const workstream = weave.workstreams[0]!;

describe("branchLayout", () => {
  const layout = branchLayout(workstream);

  it("alternates the root's children by spawn time and nests grandchildren beyond their parent", () => {
    const slot = (id: string) => (layout.laneY.get(id)! - layout.cy) / BRANCH_LANE_SPACING;
    expect(slot("root")).toBe(0);
    expect(slot("first")).toBe(-1);
    expect(slot("first-child")).toBe(-2);
    expect(slot("second")).toBe(1);
    expect(slot("third")).toBe(-3);
  });

  it("is exactly tall enough for every lane and its labels", () => {
    expect(layout.cy).toBe(BRANCH_MARGIN + 3 * BRANCH_LANE_SPACING);
    expect(layout.height).toBe(2 * BRANCH_MARGIN + 4 * BRANCH_LANE_SPACING);
  });
});

describe("branchSegments", () => {
  const layout = branchLayout(workstream);
  const cy = layout.cy;

  it("runs the root flat across its extent", () => {
    expect(branchSegments(weave.strands.get("root")!, layout, x)).toEqual([
      { d: `M0.0 ${cy.toFixed(1)}H60.0`, inferred: false },
    ]);
  });

  it("leaves the parent at the spawn, runs its lane and curves back at the rejoin", () => {
    const wide = (ms: number) => x(ms) * 10;
    const segments = branchSegments(weave.strands.get("first")!, layout, wide);
    const laneY = layout.laneY.get("first")!.toFixed(1);
    const spine = cy.toFixed(1);
    expect(segments[0]).toEqual({
      d: `M100.0 ${spine}C120.0 ${spine} 120.0 ${laneY} 140.0 ${laneY}`,
      inferred: false,
    });
    expect(segments[1]!.d).toBe(
      `M140.0 ${laneY}H460.0C480.0 ${laneY} 480.0 ${spine} 500.0 ${spine}`,
    );
  });

  it("dashes a spawn inferred from creation and stops at the end without a rejoin", () => {
    const wide = (ms: number) => x(ms) * 10;
    const segments = branchSegments(weave.strands.get("second")!, layout, wide);
    expect(segments[0]!.inferred).toBe(true);
    expect(segments[0]!.d.startsWith(`M200.0 ${cy.toFixed(1)}`)).toBe(true);
    // Fifty pixels of extent leave room for only half the usual run each way.
    expect(BRANCH_RUN).toBeGreaterThan(25);
    expect(segments[1]!.d).toBe(`M225.0 ${layout.laneY.get("second")!.toFixed(1)}H250.0`);
  });
});

const tick = (offsetMs: number, kind: WeaveEvent["kind"], failed = false): WeaveEvent => ({
  key: `${kind}:${offsetMs}`,
  ms: T0 + offsetMs,
  kind,
  failed,
  selection: failed ? { kind: "run", id: "failed" } : { kind: "lane", id: "s" },
  detail: failed ? "Run 1 failed" : null,
});

describe("clusterEvents", () => {
  it("merges events within the spacing into one node led by the most telling event", () => {
    const nodes = clusterEvents(
      "s",
      [
        tick(0, "agent"),
        tick(5 * MINUTE, "edit"),
        tick(10 * MINUTE, "error", true),
        tick(100 * MINUTE, "user"),
      ],
      x,
      40,
      200,
      24,
    );
    expect(nodes.map((node) => [node.kind, node.count, node.x, node.labelled])).toEqual([
      ["error", 3, 5, true],
      ["user", 1, 100, true],
    ]);
    expect(nodes[0]).toMatchObject({
      selection: { kind: "run", id: "failed" },
      detail: "Run 1 failed",
      y: 40,
    });
  });

  it("withholds labels from nodes closer than the label spacing", () => {
    const nodes = clusterEvents("s", [tick(0, "agent"), tick(40 * MINUTE, "edit")], x, 0, 200);
    expect(nodes.map((node) => node.labelled)).toEqual([false, false]);
  });

  it("drops events outside the field", () => {
    expect(
      clusterEvents("s", [tick(-60 * MINUTE, "agent"), tick(300 * MINUTE, "agent")], x, 0, 200),
    ).toEqual([]);
  });
});

describe("workstreamNodes", () => {
  it("widens the clustering until the whole workstream fits under the cap", () => {
    const dense = buildWeave(
      window({
        lanes: [lane("root", null)],
        runs: [run("r", { threadId: "root", requestedAt: iso(T0) })],
        activity: [
          {
            runId: "r",
            threadId: "root",
            ticks: Array.from({ length: 2000 }, (_, index) => [index * 1_000, "tool"]),
          } as never,
        ],
      }),
    );
    const layout = branchLayout(dense.workstreams[0]!);
    const nodes = workstreamNodes(
      dense.workstreams[0]!,
      layout,
      (ms) => (ms - T0) / 1_000,
      2000,
      50,
    );
    const list = nodes.get("root")!;
    expect(list.length).toBeLessThanOrEqual(50);
    expect(list.reduce((total, node) => total + node.count, 0)).toBe(2001);
  });
});
