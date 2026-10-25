import { describe, expect, it } from "vite-plus/test";

import {
  BRANCH_LANE_SPACING,
  BRANCH_MARGIN,
  BRANCH_MIN_RUN,
  BRANCH_RUN,
  branchLayout,
  branchSegments,
  branchView,
  clusterEvents,
  workstreamNodes,
} from "./loomBranch";
import { buildWeave, quietChildren, type WeaveEvent } from "./loomWeave";
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
      lane("fourth", "root", { createdAt: iso(T0 + 45 * MINUTE) }),
    ],
    runs: [
      run("r", { threadId: "root", requestedAt: iso(T0), completedAt: iso(T0 + 60 * MINUTE) }),
      run("f", {
        threadId: "first",
        requestedAt: iso(T0 + 10 * MINUTE),
        completedAt: iso(T0 + 40 * MINUTE),
      }),
      run("fc", {
        threadId: "first-child",
        requestedAt: iso(T0 + 12 * MINUTE),
        completedAt: iso(T0 + 14 * MINUTE),
      }),
      run("o", {
        threadId: "fourth",
        requestedAt: iso(T0 + 45 * MINUTE),
        completedAt: iso(T0 + 45 * MINUTE),
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
  const slots = (msPerPx: number) => {
    const layout = branchLayout(workstream, msPerPx);
    return (id: string) => (layout.laneY.get(id)! - layout.cy) / BRANCH_LANE_SPACING;
  };

  it("alternates the root's children by spawn time and nests grandchildren beyond their parent", () => {
    const slot = slots(MINUTE / 3);
    expect(slot("root")).toBe(0);
    expect(slot("first")).toBe(-1);
    expect(slot("first-child")).toBe(-2);
    expect(slot("second")).toBe(1);
    expect(slot("fourth")).toBe(2);
  });

  it("reuses a lane once the strand on it has ended", () => {
    const slot = slots(1_000);
    expect(slot("second")).toBe(1);
    expect(slot("fourth")).toBe(1);
  });

  it("keeps a lane for a short strand's title before reusing it", () => {
    // At a third of a minute per pixel a title needs 40 minutes; "second" lived for 5.
    expect(slots(MINUTE / 3)("fourth")).toBe(2);
  });

  it("never puts strands that overlap in time on one lane, and packs the rest", () => {
    const children = Array.from({ length: 40 }, (_, index) => {
      const start = T0 + ((index * 37) % 240) * MINUTE;
      return { id: `c${index}`, start, end: start + (5 + ((index * 53) % 90)) * MINUTE };
    });
    const packed = buildWeave(
      window({
        lanes: [
          lane("root", null),
          ...children.map((child) => lane(child.id, "root", { createdAt: iso(child.start) })),
        ],
        runs: [
          run("r", { threadId: "root", requestedAt: iso(T0), completedAt: iso(T0 + 400 * MINUTE) }),
          ...children.map((child) =>
            run(`r-${child.id}`, {
              threadId: child.id,
              requestedAt: iso(child.start),
              completedAt: iso(child.end),
            }),
          ),
        ],
      }),
    ).workstreams[0]!;
    const layout = branchLayout(packed, 0);
    const byLane = new Map<number, typeof children>();
    for (const child of children) {
      const y = layout.laneY.get(child.id)!;
      byLane.set(y, [...(byLane.get(y) ?? []), child]);
    }
    for (const occupants of byLane.values()) {
      const sorted = occupants.toSorted((left, right) => left.start - right.start);
      sorted.slice(1).forEach((child, index) => {
        expect(child.start).toBeGreaterThanOrEqual(sorted[index]!.end);
      });
    }
    expect(byLane.size).toBeLessThan(children.length / 2);
  });

  it("gives no lane to a child that recorded nothing but its creation", () => {
    expect(quietChildren(workstream)).toEqual(new Set(["third"]));
    expect(branchLayout(workstream, 0).laneY.has("third")).toBe(false);
  });

  it("is exactly tall enough for every lane and its labels", () => {
    const layout = branchLayout(workstream, MINUTE / 3);
    expect(layout.cy).toBe(BRANCH_MARGIN + 2 * BRANCH_LANE_SPACING);
    expect(layout.height).toBe(2 * BRANCH_MARGIN + 4 * BRANCH_LANE_SPACING);
  });
});

describe("branchView", () => {
  it("frames the workstream's own activity, not the rest of the window", () => {
    const bounds = { fromMs: T0 - 24 * 60 * MINUTE, toMs: T0 + 24 * 60 * MINUTE };
    const view = branchView(workstream, bounds, bounds.toMs);
    expect(view.fromMs).toBeLessThan(T0);
    expect(view.fromMs).toBeGreaterThan(T0 - 10 * MINUTE);
    expect(view.toMs).toBeGreaterThan(T0 + 60 * MINUTE);
    expect(view.toMs).toBeLessThan(T0 + 70 * MINUTE);
  });
});

describe("branchSegments", () => {
  const layout = branchLayout(workstream, MINUTE / 3);
  const cy = layout.cy;
  const wide = (ms: number) => x(ms) * 10;

  it("runs the root flat across its extent", () => {
    expect(branchSegments(weave.strands.get("root")!, layout, x)).toEqual({
      segments: [{ d: `M0.0 ${cy.toFixed(1)}H60.0`, inferred: false }],
      laneX: 0,
      endX: 60,
    });
  });

  it("leaves the parent at the spawn, runs its lane and curves back at the rejoin", () => {
    const path = branchSegments(weave.strands.get("first")!, layout, wide)!;
    const laneY = layout.laneY.get("first")!.toFixed(1);
    const spine = cy.toFixed(1);
    expect(path.segments[0]).toEqual({
      d: `M100.0 ${spine}C120.0 ${spine} 120.0 ${laneY} 140.0 ${laneY}`,
      inferred: false,
    });
    expect(path.segments[1]!.d).toBe(
      `M140.0 ${laneY}H460.0C480.0 ${laneY} 480.0 ${spine} 500.0 ${spine}`,
    );
    expect(path).toMatchObject({ laneX: 140, endX: 500 });
  });

  it("dashes a spawn inferred from creation and stops at the end without a rejoin", () => {
    const path = branchSegments(weave.strands.get("second")!, layout, wide)!;
    expect(path.segments[0]!.inferred).toBe(true);
    expect(path.segments[0]!.d.startsWith(`M200.0 ${cy.toFixed(1)}`)).toBe(true);
    expect(path.segments[1]!.d).toBe(
      `M${200 + BRANCH_RUN}.0 ${layout.laneY.get("second")!.toFixed(1)}H250.0`,
    );
    expect(path.endX).toBe(250);
  });

  it("bends a strand shorter than two runs over a minimum hump", () => {
    const short = buildWeave(
      window({
        lanes: [lane("root", null), lane("blip", "root", { createdAt: iso(T0 + 10 * MINUTE) })],
        runs: [
          run("r", { threadId: "root", requestedAt: iso(T0), completedAt: iso(T0 + 60 * MINUTE) }),
        ],
        edges: [
          edge("subagent_spawn", "root", "blip", T0 + 10 * MINUTE),
          edge("subagent_result", "blip", "root", T0 + 11 * MINUTE),
        ],
      }),
    );
    const path = branchSegments(
      short.strands.get("blip")!,
      branchLayout(short.workstreams[0]!, 0),
      x,
    )!;
    expect(path.laneX).toBe(10 + BRANCH_MIN_RUN);
    expect(path.endX).toBe(10 + 2 * BRANCH_MIN_RUN);
  });

  it("still draws the branch of a child with no recorded duration", () => {
    const path = branchSegments(weave.strands.get("fourth")!, layout, wide)!;
    expect(path.segments).toHaveLength(1);
    expect(path.laneX).toBeGreaterThanOrEqual(450 + BRANCH_RUN);
    expect(path.endX).toBe(path.laneX);
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
    const nodes = clusterEvents("s", [tick(0, "agent"), tick(40 * MINUTE, "edit")], x, 0, 200, 24);
    expect(nodes.map((node) => node.labelled)).toEqual([false, false]);
  });

  it("drops events outside the field", () => {
    expect(
      clusterEvents("s", [tick(-60 * MINUTE, "agent"), tick(300 * MINUTE, "agent")], x, 0, 200, 24),
    ).toEqual([]);
  });
});

describe("workstreamNodes", () => {
  const wideNodes = () =>
    workstreamNodes(workstream, branchLayout(workstream, 0), (ms) => x(ms) * 10, 1000);

  it("puts every child's spawn and rejoin on its parent, a quiet child's included", () => {
    const rootNodes = wideNodes().get("root")!;
    expect(rootNodes.find((node) => node.key === "spawn:third")).toMatchObject({
      x: 300,
      selection: { kind: "lane", id: "third" },
      detail: "third",
    });
    const rejoin = rootNodes.find((node) => node.key === "rejoin:first");
    expect(rejoin).toMatchObject({ kind: "rejoin", selection: { kind: "edge" } });
    expect(rejoin!.x).toBeGreaterThan(400);
  });

  it("keeps a child's early events on its lane, after the curve off its parent", () => {
    const [first] = wideNodes().get("first")!;
    expect(first!.x).toBe(100 + BRANCH_RUN);
  });

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
    const layout = branchLayout(dense.workstreams[0]!, 0);
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
