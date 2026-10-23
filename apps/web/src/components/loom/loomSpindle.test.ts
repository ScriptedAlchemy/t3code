import { describe, expect, it } from "vite-plus/test";

import {
  BAND_GAP,
  cullGlyphs,
  dotPaths,
  glyphCandidates,
  spindleGeometry,
  spindleLayout,
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
  const geometry = spindleGeometry(1000, 400, 1000);

  it("sits on the spine at both anchors and at its home between the fans", () => {
    expect(geometry.fan).toBe(180);
    expect(spindleY(geometry, 50, 0)).toBe(200);
    expect(spindleY(geometry, 50, 180)).toBe(50);
    expect(spindleY(geometry, 50, 500)).toBe(50);
    expect(spindleY(geometry, 50, 1000)).toBe(200);
    expect(spindleY(geometry, 50, 90)).toBe(125);
  });

  it("shrinks the fan when the tail is close to the start", () => {
    const short = spindleGeometry(1000, 400, 100);
    expect(short.fan).toBe(50);
    expect(spindleY(short, 0, 50)).toBe(0);
  });
});

describe("strandPath", () => {
  const geometry = spindleGeometry(1000, 400, 1000);

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
      run("r", { threadId: "recent", completedAt: iso(T0 + 90 * MINUTE) }),
    ],
  });
  const weave = buildWeave(data);

  it("puts the spine root on the centre line and its strands tight around it", () => {
    const layout = spindleLayout(weave, weave.workstreams[1]!, 400);
    expect(layout.spine?.rootId).toBe("busy");
    expect(layout.homeY.get("busy")).toBe(200);
    expect(layout.homeY.get("busy-child")).toBe(200 - STRAND_GAP);
  });

  it("alternates the other bands above and below, nearest first", () => {
    const layout = spindleLayout(weave, weave.workstreams[1]!, 400);
    expect(layout.bands.map((band) => band.workstream.rootId)).toEqual(["recent", "quiet"]);
    const [recent, quiet] = layout.bands;
    expect(recent!.y).toBeLessThan(200);
    expect(quiet!.y).toBeGreaterThan(200);
    expect(200 - recent!.y).toBeLessThan(quiet!.y - 200 + BAND_GAP);
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
  const glyph = (threadId: string, x: number, kind: Glyph["kind"], failed = false): Glyph => ({
    key: `${threadId}:${x}:${kind}`,
    threadId,
    x,
    y: 0,
    ms: x,
    kind,
    failed,
    selection: { kind: "lane", id: threadId },
    detail: null,
    inferred: false,
  });

  it("offers the spawn, rejoin and significant events of a strand inside the field", () => {
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
    expect(
      candidates.map((candidate) => [candidate.kind, candidate.x, candidate.inferred]),
    ).toEqual([
      ["spawn", 5, true],
      ["edit", 12, false],
      ["checkpoint", 15, false],
    ]);
  });

  it("keeps a failure over an edit in the same spot but both on different strands", () => {
    const kept = cullGlyphs(
      [glyph("a", 100, "edit"), glyph("a", 110, "error", true), glyph("b", 100, "edit")],
      26,
      250,
    );
    expect(kept.map((entry) => [entry.threadId, entry.kind])).toEqual([
      ["b", "edit"],
      ["a", "error"],
    ]);
  });

  it("never returns more than the cap, preferring the higher ranked", () => {
    const many = Array.from({ length: 300 }, (_, index) =>
      glyph(`s${index}`, index, index % 2 === 0 ? "command" : "test"),
    );
    const kept = cullGlyphs(many, 26, 250);
    expect(kept).toHaveLength(250);
    expect(kept.filter((entry) => entry.kind === "test")).toHaveLength(150);
    expect(kept.map((entry) => entry.x)).toEqual(
      kept.map((entry) => entry.x).toSorted((a, b) => a - b),
    );
  });
});
