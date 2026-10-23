import { WEAVE_KINDS, type WeaveEventKind } from "./loomKinds";
import type { LoomSelection } from "./loomSearch";
import type { Weave, WeaveEvent, WeaveStrand, Workstream } from "./loomWeave";

/** Distance between strands inside a band, and between bands. */
export const STRAND_GAP = 6;
export const BAND_GAP = 20;
const FIELD_MARGIN = 28;
/**
 * A sparse weave spreads to fill the field, at least to MIN_OCCUPY of its height, but its strands
 * never sit further apart than MAX_STRAND_GAP or they stop reading as one weave.
 */
const MAX_SPREAD = 4;
const MIN_OCCUPY = 0.35;
const MAX_STRAND_GAP = 48;

export interface SpindleGeometry {
  readonly cy: number;
  readonly startX: number;
  readonly tailX: number;
  /** How far the strands take to leave the spine and to rejoin it. */
  readonly fan: number;
}

/** The fan takes 18% of the field each side, or half the spindle when it is shorter than that. */
export function spindleGeometry(width: number, height: number, tailX: number): SpindleGeometry {
  const startX = 0;
  const clampedTail = Math.max(startX, tailX);
  return {
    cy: height / 2,
    startX,
    tailX: clampedTail,
    fan: Math.min(width * 0.18, (clampedTail - startX) / 2),
  };
}

const smoothstep = (from: number, to: number, x: number) => {
  if (to <= from) return x >= to ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/** A strand's y at x: on the spine at both anchors, at its home y between the fans. */
export function spindleY(geometry: SpindleGeometry, homeY: number, x: number): number {
  const { cy, startX, tailX, fan } = geometry;
  const spread = smoothstep(startX, startX + fan, x) * (1 - smoothstep(tailX - fan, tailX, x));
  return cy + (homeY - cy) * spread;
}

/** The strand sampled from xa to xb, dense inside the fans and straight between them. */
export function strandPath(geometry: SpindleGeometry, homeY: number, xa: number, xb: number) {
  if (!(xb > xa)) return "";
  const xs: number[] = [xa];
  const { startX, tailX, fan } = geometry;
  const step = Math.max(2, fan / 12);
  for (const [from, to] of [
    [startX, startX + fan],
    [tailX - fan, tailX],
  ]) {
    for (let x = from!; x <= to!; x += step) if (x > xa && x < xb) xs.push(x);
  }
  xs.push(xb);
  return xs
    .map(
      (x, index) =>
        `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${spindleY(geometry, homeY, x).toFixed(1)}`,
    )
    .join("");
}

export interface SpindleBand {
  readonly workstream: Workstream;
  /** Where the band's label sits. */
  readonly y: number;
}

export interface SpindleLayout {
  readonly cy: number;
  readonly spine: Workstream | null;
  /** Bands other than the spine, nearest first. */
  readonly bands: ReadonlyArray<SpindleBand>;
  /** Every strand's home y, the spine root at cy. */
  readonly homeY: ReadonlyMap<string, number>;
}

/**
 * The spine workstream sits on the centre line, its other strands close around it, busiest
 * nearest. Remaining
 * workstreams alternate above and below, most recently active nearest. The whole stack scales
 * about the centre to fill the field: compressed when it is too tall, spread when it is sparse.
 */
export function spindleLayout(
  weave: Weave,
  spine: Workstream | null,
  height: number,
): SpindleLayout {
  const cy = height / 2;
  const offsets = new Map<string, number>();
  const bands: Array<{ workstream: Workstream; offset: number }> = [];
  let above = 0;
  let below = 0;
  if (spine !== null) {
    // The busiest strands sit next to the spine, where the eye starts; the ones that recorded
    // little take the outer edge.
    const [root, ...rest] = spine.strands;
    const ordered = [
      root!,
      ...rest.toSorted((left, right) => right.events.length - left.events.length),
    ];
    ordered.forEach((strand, index) => {
      const k = Math.ceil(index / 2) * STRAND_GAP;
      offsets.set(strand.threadId, index % 2 === 1 ? -k : k);
    });
    const half = Math.ceil((spine.strands.length - 1) / 2) * STRAND_GAP;
    above = -half;
    below = half;
  }
  weave.workstreams
    .filter((workstream) => workstream !== spine)
    .forEach((workstream, index) => {
      const size = workstream.strands.length * STRAND_GAP;
      const sign = index % 2 === 0 ? -1 : 1;
      const edge = sign < 0 ? (above -= BAND_GAP) : (below += BAND_GAP);
      workstream.strands.forEach((strand, position) => {
        offsets.set(strand.threadId, edge + sign * (STRAND_GAP / 2 + position * STRAND_GAP));
      });
      bands.push({ workstream, offset: edge + (sign * size) / 2 });
      if (sign < 0) above -= size;
      else below += size;
    });
  const needed = Math.max(-above, below) * 2;
  const margin = Math.min(FIELD_MARGIN, height / 8);
  const spread = Math.min(
    MAX_STRAND_GAP / STRAND_GAP,
    Math.max(MAX_SPREAD, (height * MIN_OCCUPY) / needed),
  );
  const scale = needed > 0 ? Math.min(spread, (height - 2 * margin) / needed) : 1;
  return {
    cy,
    spine,
    bands: bands.map(({ workstream, offset }) => ({ workstream, y: cy + offset * scale })),
    homeY: new Map([...offsets].map(([threadId, offset]) => [threadId, cy + offset * scale])),
  };
}

export interface TickDot {
  readonly kind: WeaveEventKind;
  readonly x: number;
  readonly y: number;
  readonly count: number;
}

/** Ticks on one strand collapsed to one dot per pixel column, coloured by the telling kind. */
export function strandDots(
  events: ReadonlyArray<WeaveEvent>,
  x: (ms: number) => number,
  y: (x: number) => number,
  width: number,
): ReadonlyArray<TickDot> {
  const columns = new Map<number, { kind: WeaveEventKind; count: number }>();
  for (const event of events) {
    if (event.selection.kind !== "lane") continue;
    const column = Math.floor(x(event.ms));
    if (column < 0 || column >= width) continue;
    const bin = columns.get(column);
    if (bin === undefined) columns.set(column, { kind: event.kind, count: 1 });
    else {
      bin.count += 1;
      if (WEAVE_KINDS[event.kind].priority > WEAVE_KINDS[bin.kind].priority) bin.kind = event.kind;
    }
  }
  return [...columns].map(([column, bin]) => ({
    kind: bin.kind,
    x: column + 0.5,
    y: y(column + 0.5),
    count: bin.count,
  }));
}

/** One path per kind, so thousands of dots stay a handful of elements. */
export function dotPaths(dots: ReadonlyArray<TickDot>): ReadonlyMap<WeaveEventKind, string> {
  const parts = new Map<WeaveEventKind, string[]>();
  for (const dot of dots) {
    const r = 1.4 + Math.min(1.2, Math.log2(dot.count) * 0.4);
    const segment = `M${(dot.x - r).toFixed(1)} ${dot.y.toFixed(1)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
    const list = parts.get(dot.kind);
    if (list === undefined) parts.set(dot.kind, [segment]);
    else list.push(segment);
  }
  return new Map([...parts].map(([kind, segments]) => [kind, segments.join("")]));
}

export interface Glyph {
  readonly key: string;
  readonly threadId: string;
  readonly x: number;
  readonly y: number;
  readonly ms: number;
  readonly kind: WeaveEventKind;
  readonly failed: boolean;
  readonly selection: LoomSelection;
  readonly detail: string | null;
}

export const GLYPH_RADIUS = 7;
export const GLYPH_SPACING = 26;
export const GLYPH_CAP = 250;

/**
 * The events worth a glyph on a strand. Spawns and rejoins are left to Agent mode: in the overview
 * the strand leaving and returning to the spine already shows them.
 */
export function glyphCandidates(
  strand: WeaveStrand,
  x: (ms: number) => number,
  y: (x: number) => number,
  width: number,
): Glyph[] {
  return strand.events.flatMap((event) => {
    if (!WEAVE_KINDS[event.kind].significant) return [];
    const px = x(event.ms);
    if (px < 0 || px > width) return [];
    return [
      {
        key: event.key,
        threadId: strand.threadId,
        x: px,
        y: y(px),
        ms: event.ms,
        kind: event.kind,
        failed: event.failed,
        selection: event.selection,
        detail: event.detail,
      },
    ];
  });
}

const glyphRank = (glyph: Glyph) => (glyph.failed ? 100 : 0) + WEAVE_KINDS[glyph.kind].priority;

/**
 * Keeps the most telling glyphs: failures first, then by kind. A glyph is dropped when a kept one
 * is within `spacing` along the time axis and close enough vertically to touch it, which covers
 * both a busy strand and strands that crowd together inside the fans. Never more than `cap` in
 * all, returned left to right.
 */
export function cullGlyphs(
  candidates: ReadonlyArray<Glyph>,
  spacing = GLYPH_SPACING,
  cap = GLYPH_CAP,
  radius = GLYPH_RADIUS,
): ReadonlyArray<Glyph> {
  const ordered = candidates.toSorted(
    (left, right) => glyphRank(right) - glyphRank(left) || left.ms - right.ms,
  );
  const kept: Glyph[] = [];
  for (const glyph of ordered) {
    if (kept.length >= cap) break;
    const touches = kept.some(
      (other) =>
        Math.abs(other.x - glyph.x) < spacing && Math.abs(other.y - glyph.y) < 2 * radius + 2,
    );
    if (!touches) kept.push(glyph);
  }
  return kept.sort((left, right) => left.x - right.x);
}
