import { describe, expect, it } from "vite-plus/test";

import {
  BAND_GAP,
  cullGlyphs,
  dotPaths,
  glyphCandidates,
  spindleGeometry,
  SPINDLE_LEAD,
  spindleLayout,
  spindleView,
  spindleY,
  STRAND_GAP,
  strandDots,
  strandPath,
  type Glyph,
} from "./loomSpindle";
import { buildWeave, type WeaveEvent } from "./loomWeave";
import { checkpoint, edge, iso, lane, run, window } from "./loomWeave.test";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-22T12:00:00.000Z");

describe("spindleY", () => {
  const geometry = spindleGeometry(1000, 400, 0, 1000);

  it("sits on the spine at both anchors and at its home between the fans", () => {
    expect(geometry.fan).toBe(180);
    expect(spindleY(geometry, 50, 0)).toBe(200);
    expect(spindleY(geometry, 50, 180)).toBe(50);
    expect(spindleY(geometry, 50, 500)).toBe(50);
    expect(spindleY(geometry, 50, 1000)).toBe(200);
    expect(spindleY(geometry, 50, 90)).toBe(125);
  });

  it("shrinks the fan when the tail is close to the start", () => {
    const short = spindleGeometry(1000, 400, 0, 100);
    expect(short.fan).toBe(50);
    expect(spindleY(short, 0, 50)).toBe(0);
  });
});

describe("strandPath", () => {
  const geometry = spindleGeometry(1000, 400, 0, 1000);

  it("starts and ends exactly at the requested extent and bends only inside the fans", () => {
    const path = strandPath(geometry, 100, 120, 700);
    const points = path.split(/[ML]/).filter(Boolean);
    expect(points[0]).toBe(`120.0 ${spindleY(geometry, 100, 120).toFixed(1)}`);
    expect(points.at(-1)).toBe("700.0 100.0");
    const xs = points.map((point) => Number(point.split(" ")[0]));
    expect(xs.filter((x) => x > 180 && x < 820)).toEqual([700]);
  });

  it("is empty for an extent with no length", () => {
    expect(strandPath(geometry, 100, 300, 300)).toBe("");
  });
});

describe("spindleView", () => {
  it("frames the window's activity through the loaded tail, with the label room on the left", () => {
    const bounds = { fromMs: T0 - 24 * 60 * MINUTE, toMs: T0 + 60 * MINUTE };
    const weave = buildWeave(
      window({
        from: iso(bounds.fromMs),
        to: iso(bounds.toMs),
        asOf: iso(T0 + 50 * MINUTE),
        lanes: [lane("root", null)],
        runs: [run("r", { threadId: "root", requestedAt: iso(T0), completedAt: iso(T0 + MINUTE) })],
      }),
    );
    expect(weave.startMs).toBe(T0);
    expect(weave.tailMs).toBe(T0 + 50 * MINUTE);
    const view = spindleView(weave, bounds);
    const span = view.toMs - view.fromMs;
    expect((T0 - view.fromMs) / span).toBeCloseTo(SPINDLE_LEAD);
    expect(view.toMs).toBeGreaterThan(weave.tailMs);
    expect(view.toMs).toBeLessThanOrEqual(bounds.toMs);
  });
});

describe("spindleLayout", () => {
  const data = window({
    lanes: [
      lane("quiet", null),
      lane("busy", null),
      lane("busy-child", "busy"),
      lane("recent", null),
    ],
    runs: [
      run("q", { threadId: "quiet", requestedAt: iso(T0), completedAt: iso(T0 + MINUTE) }),
      run("b", { threadId: "busy", completedAt: iso(T0 + 50 * MINUTE) }),
      run("bc", { threadId: "busy-child", completedAt: iso(T0 + 40 * MINUTE) }),
      run("r", { threadId: "recent", completedAt: iso(T0 + 90 * MINUTE) }),
    ],
  });
  const weave = buildWeave(data);

  it("puts the spine root on the centre line and its strands next to it", () => {
    const layout = spindleLayout(weave, weave.workstreams[1]!, 400);
    expect(layout.spine?.rootId).toBe("busy");
    expect(layout.homeY.get("busy")).toBe(200);
    const childOffset = 200 - layout.homeY.get("busy-child")!;
    expect(childOffset).toBeGreaterThanOrEqual(STRAND_GAP);
    expect(childOffset).toBeLessThan(200 - layout.bands[0]!.y);
  });

  it("spreads a sparse weave to fill the field, but only so far", () => {
    const spread = (height: number) => {
      const layout = spindleLayout(weave, weave.workstreams[0]!, height);
      const ys = [...layout.homeY.values()];
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(spread(200)).toBeGreaterThan(spread(120));
    expect(spread(2000)).toBe(spread(4000));
    expect(spread(2000)).toBeLessThan(2000 / 4);
  });

  it("alternates the other bands above and below, nearest first", () => {
    const layout = spindleLayout(weave, weave.workstreams[1]!, 400);
    expect(layout.bands.map((band) => band.workstream.rootId)).toEqual(["recent", "quiet"]);
    const [recent, quiet] = layout.bands;
    expect(recent!.y).toBeLessThan(200);
    expect(quiet!.y).toBeGreaterThan(200);
    expect(200 - recent!.y).toBeLessThan(quiet!.y - 200 + BAND_GAP);
  });

  it("gives a child that recorded nothing but its creation no strand", () => {
    const quiet = buildWeave(
      window({
        lanes: [lane("root", null), lane("blip", "root")],
        runs: [run("r", { threadId: "root" })],
      }),
    );
    const layout = spindleLayout(quiet, quiet.workstreams[0]!, 400);
    expect([...layout.homeY.keys()]).toEqual(["root"]);
  });

  it("compresses toward the centre when the field is too short", () => {
    const tall = spindleLayout(weave, weave.workstreams[0]!, 400);
    const short = spindleLayout(weave, weave.workstreams[0]!, 40);
    for (const [threadId, y] of short.homeY) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(40);
      expect(Math.sign(y - 20)).toBe(Math.sign(tall.homeY.get(threadId)! - 200));
    }
  });
});

const tick = (ms: number, kind: WeaveEvent["kind"]): WeaveEvent => ({
  key: `tick:${ms}:${kind}`,
  ms,
  kind,
  failed: kind === "error",
  selection: { kind: "lane", id: "s" },
  detail: null,
});

describe("strandDots", () => {
  const x = (ms: number) => ms / MINUTE;

  it("keeps one dot per pixel column with the telling kind and the count", () => {
    const dots = strandDots(
      [tick(10 * MINUTE, "agent"), tick(10.2 * MINUTE, "edit"), tick(30 * MINUTE, "tool")],
      x,
      () => 7,
      100,
    );
    expect(dots).toEqual([
      { kind: "edit", x: 10.5, y: 7, count: 2 },
      { kind: "tool", x: 30.5, y: 7, count: 1 },
    ]);
    expect([...dotPaths(dots).keys()]).toEqual(["edit", "tool"]);
  });

  it("drops markers, which get glyphs, and ticks outside the field", () => {
    const marker: WeaveEvent = {
      ...tick(5 * MINUTE, "checkpoint"),
      selection: { kind: "marker", id: "m" },
    };
    expect(
      strandDots([marker, tick(-MINUTE, "agent"), tick(500 * MINUTE, "agent")], x, () => 0, 100),
    ).toEqual([]);
  });
});

describe("glyphCandidates and cullGlyphs", () => {
  const glyph = (
    threadId: string,
    x: number,
    kind: Glyph["kind"],
    failed = false,
    y = 0,
  ): Glyph => ({
    key: `${threadId}:${x}:${kind}`,
    threadId,
    x,
    y,
    ms: x,
    kind,
    failed,
    selection: { kind: "lane", id: threadId },
    detail: null,
  });

  it("offers the significant events of a strand inside the field, not its spawn or rejoin", () => {
    const weave = buildWeave(
      window({
        lanes: [lane("root", null), lane("child", "root", { createdAt: iso(T0 + 5 * MINUTE) })],
        runs: [run("c", { threadId: "child" })],
        markers: [
          checkpoint("child", T0 + 15 * MINUTE, 2),
          checkpoint("child", T0 + 16 * MINUTE, 0),
        ],
        edges: [edge("subagent_result", "child", "root", T0 + 21 * MINUTE)],
        activity: [
          {
            runId: "c",
            threadId: "child",
            ticks: [
              [MINUTE, "agent"],
              [2 * MINUTE, "edit"],
            ],
          } as never,
        ],
      }),
    );
    const candidates = glyphCandidates(
      weave.strands.get("child")!,
      (ms) => (ms - T0) / MINUTE,
      () => 0,
      20,
    );
    expect(candidates.map((candidate) => [candidate.kind, candidate.x])).toEqual([
      ["edit", 12],
      ["checkpoint", 15],
    ]);
  });

  it("keeps a failure over an edit that would touch it, but not over one clear of it", () => {
    const kept = cullGlyphs(
      [
        glyph("a", 100, "edit"),
        glyph("a", 110, "error", true),
        glyph("b", 104, "edit", false, 8),
        glyph("c", 100, "edit", false, 30),
      ],
      26,
      250,
      6,
    );
    expect(kept.map((entry) => [entry.threadId, entry.kind])).toEqual([
      ["c", "edit"],
      ["a", "error"],
    ]);
  });

  it("never returns more than the cap, preferring the higher ranked", () => {
    const many = Array.from({ length: 300 }, (_, index) =>
      glyph(`s${index}`, index, index % 2 === 0 ? "command" : "test", false, index * 20),
    );
    const kept = cullGlyphs(many, 26, 250);
    expect(kept).toHaveLength(250);
    expect(kept.filter((entry) => entry.kind === "test")).toHaveLength(150);
    expect(kept.map((entry) => entry.x)).toEqual(
      kept.map((entry) => entry.x).toSorted((a, b) => a - b),
    );
  });
});
