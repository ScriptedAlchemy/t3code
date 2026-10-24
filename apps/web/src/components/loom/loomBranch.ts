import { WEAVE_KINDS, type WeaveEventKind } from "./loomKinds";
import { frameLoomSpan, type LoomView } from "./loomScale";
import type { LoomSelection } from "./loomSearch";
import { quietChildren, type WeaveEvent, type WeaveStrand, type Workstream } from "./loomWeave";

export const BRANCH_LANE_SPACING = 96;
/** Room above the top lane and below the bottom one for nodes and their labels. */
export const BRANCH_MARGIN = 56;
/** The horizontal run of the S-curve that leaves or rejoins a parent. */
export const BRANCH_RUN = 40;
/** A strand too short for two full runs still bends over at least this, so it reads as a hump. */
export const BRANCH_MIN_RUN = 14;
const LANE_GAP = 24;
const LANE_LABEL = 120;
/** Spawns this many px apart at the fitted zoom leave from what reads as one point. */
const BURST = 24;

export interface BranchLayout {
  readonly cy: number;
  readonly height: number;
  readonly laneY: ReadonlyMap<string, number>;
}

const startOf = (strand: WeaveStrand) =>
  strand.spawn?.ms ?? strand.extent?.startMs ?? Number.POSITIVE_INFINITY;
const endOf = (strand: WeaveStrand) =>
  Math.max(startOf(strand), strand.rejoin?.ms ?? strand.extent?.endMs ?? 0);

/**
 * Frames one workstream's activity: its events, transfers and the ends of its strands, which reach
 * the loaded tail while one still runs. Creation times stay out, so an old root does not stretch
 * the frame. The whole window when nothing on it happened inside the window.
 */
export function branchView(workstream: Workstream, bounds: LoomView, tailMs: number): LoomView {
  const times = workstream.strands
    .flatMap((strand) => [
      strand.events[0]?.ms,
      strand.events.at(-1)?.ms,
      strand.spawn?.ms,
      strand.rejoin?.ms,
      strand.extent === null ? undefined : Math.min(strand.extent.endMs, tailMs),
    ])
    .filter((ms): ms is number => ms !== undefined && ms >= bounds.fromMs && ms <= bounds.toMs);
  return frameLoomSpan(
    times.length === 0 ? null : { firstMs: Math.min(...times), lastMs: Math.max(...times) },
    bounds,
  );
}

/**
 * The root takes the centre lane. Children take lanes in spawn order, nearest free lane first,
 * alternating above and below, and a child's own children go beyond it on its side, so a subtree
 * reads as one wedge. Like a Gantt chart, a lane is reused once its strand has ended: it stays
 * taken for LANE_GAP px after the strand ends, and for at least LANE_LABEL px after it starts so
 * a short strand keeps room for its title. Pixels convert to time at `msPerPx`, the fitted zoom,
 * so lanes stay put while the view zooms.
 */
export function branchLayout(
  workstream: Workstream,
  msPerPx: number,
  spacing = BRANCH_LANE_SPACING,
  margin = BRANCH_MARGIN,
): BranchLayout {
  const byId = new Map(workstream.strands.map((strand) => [strand.threadId, strand]));
  const quiet = quietChildren(workstream);
  const slots = new Map<string, number>([[workstream.rootId, 0]]);
  const occupied = new Map<number, Array<readonly [number, number]>>();
  let nextSide = -1;
  const fits = (slot: number, from: number, to: number) =>
    (occupied.get(slot) ?? []).every(([start, end]) => to <= start || from >= end);
  const place = (strand: WeaveStrand): number | undefined => {
    const known = slots.get(strand.threadId);
    if (known !== undefined) return known;
    if (strand.parentThreadId === null || strand.extent === null || quiet.has(strand.threadId))
      return undefined;
    const parent = byId.get(strand.parentThreadId);
    const parentSlot = parent === undefined ? 0 : (place(parent) ?? 0);
    const from = startOf(strand);
    const to = Math.max(endOf(strand) + LANE_GAP * msPerPx, from + LANE_LABEL * msPerPx);
    let slot = 0;
    if (parentSlot === 0) {
      for (let k = 1; slot === 0; k++) {
        if (fits(nextSide * k, from, to)) slot = nextSide * k;
        else if (fits(-nextSide * k, from, to)) slot = -nextSide * k;
      }
      nextSide = -Math.sign(slot);
    } else {
      const side = Math.sign(parentSlot);
      for (let k = Math.abs(parentSlot) + 1; slot === 0; k++) {
        if (fits(side * k, from, to)) slot = side * k;
      }
    }
    occupied.set(slot, [...(occupied.get(slot) ?? []), [from, to]]);
    slots.set(strand.threadId, slot);
    return slot;
  };
  // Children that leave at the same point take lanes shortest first, so a longer strand encloses
  // the shorter ones and its rejoin does not cross their lanes.
  const burst = (strand: WeaveStrand) => Math.floor(startOf(strand) / (BURST * msPerPx || 1));
  const order = workstream.strands.toSorted(
    (left, right) =>
      burst(left) - burst(right) || endOf(left) - endOf(right) || startOf(left) - startOf(right),
  );
  for (const strand of order) place(strand);
  const values = [...slots.values()];
  const above = -Math.min(0, ...values);
  const below = Math.max(0, ...values);
  const cy = margin + above * spacing;
  return {
    cy,
    height: cy + below * spacing + margin,
    laneY: new Map([...slots].map(([threadId, slot]) => [threadId, cy + slot * spacing])),
  };
}

export interface BranchSegment {
  readonly d: string;
  /** Drawn dashed: a spawn inferred from creation rather than a recorded transfer. */
  readonly inferred: boolean;
}

export interface BranchStrandPath {
  readonly segments: ReadonlyArray<BranchSegment>;
  /** Where the strand's own lane begins, after the curve off its parent. */
  readonly laneX: number;
  /** Where it ends: the rejoin on the parent, or the terminal node on its lane. */
  readonly endX: number;
}

/**
 * A root runs flat across its extent. A child leaves its parent at the spawn time with an
 * S-curve, runs flat on its lane, and curves back at its rejoin or stops at its end. The curve off
 * the parent is always drawn whole, so a child with no recorded duration still shows where it
 * branched.
 */
export function branchSegments(
  strand: WeaveStrand,
  layout: BranchLayout,
  x: (ms: number) => number,
): BranchStrandPath | null {
  const y = layout.laneY.get(strand.threadId);
  if (y === undefined || strand.extent === null) return null;
  const parentY =
    strand.parentThreadId === null ? undefined : layout.laneY.get(strand.parentThreadId);
  const f = (n: number) => n.toFixed(1);
  if (strand.spawn === null || parentY === undefined) {
    const startX = x(strand.extent.startMs);
    const endX = Math.max(startX, x(strand.extent.endMs));
    return {
      segments: endX > startX ? [{ d: `M${f(startX)} ${f(y)}H${f(endX)}`, inferred: false }] : [],
      laneX: startX,
      endX,
    };
  }
  const spawnX = x(strand.spawn.ms);
  const rejoinX = strand.rejoin === null ? null : x(strand.rejoin.ms);
  // A branch that climbs several lanes gets a longer run, so it reads as a curve, not a wall.
  const climb = Math.min(BRANCH_RUN * 3, Math.max(BRANCH_RUN, Math.abs(y - parentY) * 0.4));
  const run =
    rejoinX === null ? climb : Math.max(BRANCH_MIN_RUN, Math.min(climb, (rejoinX - spawnX) / 2));
  const laneX = spawnX + run;
  const bodyEnd =
    rejoinX === null ? Math.max(laneX, x(strand.extent.endMs)) : Math.max(laneX, rejoinX - run);
  const endX = rejoinX === null ? bodyEnd : bodyEnd + run;
  const curve = (fromX: number, fromY: number, toX: number, toY: number) =>
    `C${f(fromX + run / 2)} ${f(fromY)} ${f(toX - run / 2)} ${f(toY)} ${f(toX)} ${f(toY)}`;
  const leave: BranchSegment = {
    d: `M${f(spawnX)} ${f(parentY)}${curve(spawnX, parentY, laneX, y)}`,
    inferred: !strand.spawn.exact,
  };
  const back = rejoinX === null ? "" : curve(bodyEnd, y, endX, parentY);
  const body = bodyEnd > laneX || back !== "" ? `M${f(laneX)} ${f(y)}H${f(bodyEnd)}${back}` : "";
  return {
    segments: body === "" ? [leave] : [leave, { d: body, inferred: false }],
    laneX,
    endX,
  };
}

export interface BranchNode {
  readonly key: string;
  readonly threadId: string;
  readonly x: number;
  readonly y: number;
  readonly kind: WeaveEventKind;
  readonly failed: boolean;
  readonly selection: LoomSelection;
  readonly detail: string | null;
  readonly ms: number;
  readonly count: number;
  /** Far enough from its neighbours for the three-line label. */
  readonly labelled: boolean;
}

const NODE_SPACING = 72;
const LABEL_SPACING = 72;
const NODE_CAP = 400;

const rank = (event: WeaveEvent) => (event.failed ? 100 : 0) + WEAVE_KINDS[event.kind].priority;

/**
 * Events within `spacing` px of each other become one node that takes the most telling event's
 * kind, selection and detail, and counts the rest. Events left of `minX` sit at `minX`: a child's
 * first events come seconds after its spawn, before its curve has reached its lane.
 */
export function clusterEvents(
  threadId: string,
  events: ReadonlyArray<WeaveEvent>,
  x: (ms: number) => number,
  y: number,
  width: number,
  spacing = NODE_SPACING,
  minX = Number.NEGATIVE_INFINITY,
): BranchNode[] {
  const nodes: Array<{ first: number; last: number; lead: WeaveEvent; count: number }> = [];
  for (const event of events) {
    const px = Math.max(minX, x(event.ms));
    if (px < 0 || px > width) continue;
    const current = nodes.at(-1);
    if (current !== undefined && px - current.first < spacing) {
      current.last = px;
      current.count += 1;
      if (rank(event) > rank(current.lead)) current.lead = event;
    } else nodes.push({ first: px, last: px, lead: event, count: 1 });
  }
  return nodes.map((node, index) => {
    const cx = (node.first + node.last) / 2;
    const previous = nodes[index - 1];
    const next = nodes[index + 1];
    const gap = (other: typeof node | undefined) =>
      other === undefined || Math.abs((other.first + other.last) / 2 - cx) >= LABEL_SPACING;
    return {
      key: node.lead.key,
      threadId,
      x: cx,
      y,
      kind: node.lead.kind,
      failed: node.lead.failed,
      selection: node.lead.selection,
      detail: node.lead.detail,
      ms: node.lead.ms,
      count: node.count,
      labelled: gap(previous) && gap(next),
    };
  });
}

/**
 * Nodes for every strand in the workstream, with each child's spawn and rejoin among its parent's
 * events, so transfers at the same moment cluster instead of stacking. When the total passes the cap the spacing doubles until it fits, so a busy workstream
 * still renders a bounded number of elements.
 */
export function workstreamNodes(
  workstream: Workstream,
  layout: BranchLayout,
  x: (ms: number) => number,
  width: number,
  cap = NODE_CAP,
): ReadonlyMap<string, ReadonlyArray<BranchNode>> {
  const transfers = new Map<string, WeaveEvent[]>();
  const add = (parentId: string, event: WeaveEvent) => {
    const list = transfers.get(parentId) ?? [];
    list.push(event);
    transfers.set(parentId, list);
  };
  for (const strand of workstream.strands) {
    if (strand.parentThreadId === null) continue;
    if (strand.spawn !== null) {
      add(strand.parentThreadId, {
        key: `spawn:${strand.threadId}`,
        ms: strand.spawn.ms,
        kind: "spawn",
        failed: false,
        selection: { kind: "lane", id: strand.threadId },
        detail: strand.title,
      });
    }
    if (strand.rejoin !== null) {
      add(strand.parentThreadId, {
        key: `rejoin:${strand.threadId}`,
        ms: strand.rejoin.ms,
        kind: "rejoin",
        failed: false,
        selection: { kind: "edge", id: strand.rejoin.edgeId },
        detail: strand.title,
      });
    }
  }
  const eventsOf = (strand: WeaveStrand) => {
    const extra = transfers.get(strand.threadId);
    return extra === undefined
      ? strand.events
      : [...strand.events, ...extra].sort((left, right) => left.ms - right.ms);
  };
  for (let spacing = NODE_SPACING; ; spacing *= 2) {
    const result = new Map<string, BranchNode[]>();
    let total = 0;
    for (const strand of workstream.strands) {
      const y = layout.laneY.get(strand.threadId);
      if (y === undefined) continue;
      const laneX = branchSegments(strand, layout, x)?.laneX;
      const nodes = clusterEvents(
        strand.threadId,
        eventsOf(strand),
        x,
        y,
        width,
        spacing,
        strand.parentThreadId === null ? undefined : laneX,
      );
      total += nodes.length;
      result.set(strand.threadId, nodes);
    }
    if (total <= cap || spacing > width) return result;
  }
}
