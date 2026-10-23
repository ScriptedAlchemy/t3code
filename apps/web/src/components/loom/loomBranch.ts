import { WEAVE_KINDS, type WeaveEventKind } from "./loomKinds";
import type { LoomSelection } from "./loomSearch";
import type { WeaveEvent, WeaveStrand, Workstream } from "./loomWeave";

export const BRANCH_LANE_SPACING = 84;
/** Room above the top lane and below the bottom one for nodes and their labels. */
export const BRANCH_MARGIN = 56;
/** The horizontal run of the S-curve that leaves or rejoins a parent. */
export const BRANCH_RUN = 40;

export interface BranchLayout {
  readonly cy: number;
  readonly height: number;
  readonly laneY: ReadonlyMap<string, number>;
}

const spawnOrder = (strand: WeaveStrand) =>
  strand.spawn?.ms ?? strand.extent?.startMs ?? Number.POSITIVE_INFINITY;

/**
 * The root takes the centre lane. Its children alternate above and below in spawn order, and a
 * child's own children nest on its side beyond it, so a subtree reads as one wedge.
 */
export function branchLayout(
  workstream: Workstream,
  spacing = BRANCH_LANE_SPACING,
  margin = BRANCH_MARGIN,
): BranchLayout {
  const children = new Map<string, WeaveStrand[]>();
  for (const strand of workstream.strands) {
    if (strand.parentThreadId === null) continue;
    const siblings = children.get(strand.parentThreadId) ?? [];
    siblings.push(strand);
    children.set(strand.parentThreadId, siblings);
  }
  const slots = new Map<string, number>([[workstream.rootId, 0]]);
  const extent = { above: 0, below: 0 };
  const place = (parentId: string, side: "above" | "below" | null) => {
    const ordered = (children.get(parentId) ?? []).toSorted(
      (left, right) => spawnOrder(left) - spawnOrder(right),
    );
    ordered.forEach((child, index) => {
      const own = side ?? (index % 2 === 0 ? "above" : "below");
      extent[own] += 1;
      slots.set(child.threadId, own === "above" ? -extent[own] : extent[own]);
      place(child.threadId, own);
    });
  };
  place(workstream.rootId, null);
  const cy = margin + extent.above * spacing;
  return {
    cy,
    height: cy + extent.below * spacing + margin,
    laneY: new Map([...slots].map(([threadId, slot]) => [threadId, cy + slot * spacing])),
  };
}

export interface BranchSegment {
  readonly d: string;
  /** Drawn dashed: a spawn inferred from creation rather than a recorded transfer. */
  readonly inferred: boolean;
}

/**
 * A root runs flat across its extent. A child leaves its parent at the spawn time with an
 * S-curve, runs flat on its lane, and curves back at its rejoin or stops at its end.
 */
export function branchSegments(
  strand: WeaveStrand,
  layout: BranchLayout,
  x: (ms: number) => number,
): ReadonlyArray<BranchSegment> {
  const y = layout.laneY.get(strand.threadId);
  if (y === undefined || strand.extent === null) return [];
  const parentY =
    strand.parentThreadId === null ? undefined : layout.laneY.get(strand.parentThreadId);
  const endMs = strand.rejoin?.ms ?? strand.extent.endMs;
  const endX = x(endMs);
  const f = (n: number) => n.toFixed(1);
  if (strand.spawn === null || parentY === undefined) {
    const startX = x(strand.extent.startMs);
    return endX > startX ? [{ d: `M${f(startX)} ${f(y)}H${f(endX)}`, inferred: false }] : [];
  }
  const spawnX = x(strand.spawn.ms);
  const run = Math.max(0, Math.min(BRANCH_RUN, (endX - spawnX) / 2));
  const curve = (fromX: number, fromY: number, toX: number, toY: number) =>
    `C${f(fromX + run / 2)} ${f(fromY)} ${f(toX - run / 2)} ${f(toY)} ${f(toX)} ${f(toY)}`;
  const leave: BranchSegment = {
    d: `M${f(spawnX)} ${f(parentY)}${curve(spawnX, parentY, spawnX + run, y)}`,
    inferred: !strand.spawn.exact,
  };
  const bodyEnd = strand.rejoin === null ? endX : endX - run;
  const body = `M${f(spawnX + run)} ${f(y)}H${f(bodyEnd)}`;
  const back = strand.rejoin === null ? "" : curve(bodyEnd, y, endX, parentY);
  return [leave, { d: body + back, inferred: false }];
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

export const NODE_SPACING = 24;
export const LABEL_SPACING = 64;
export const NODE_CAP = 400;

const rank = (event: WeaveEvent) => (event.failed ? 100 : 0) + WEAVE_KINDS[event.kind].priority;

/**
 * Events within `spacing` px of each other become one node that takes the most telling event's
 * kind, selection and detail, and counts the rest.
 */
export function clusterEvents(
  threadId: string,
  events: ReadonlyArray<WeaveEvent>,
  x: (ms: number) => number,
  y: number,
  width: number,
  spacing = NODE_SPACING,
): BranchNode[] {
  const nodes: Array<{ first: number; last: number; lead: WeaveEvent; count: number }> = [];
  for (const event of events) {
    const px = x(event.ms);
    if (px < -spacing || px > width + spacing) continue;
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
 * Nodes for every strand in the workstream. When the total passes the cap the spacing doubles
 * until it fits, so a busy workstream still renders a bounded number of elements.
 */
export function workstreamNodes(
  workstream: Workstream,
  layout: BranchLayout,
  x: (ms: number) => number,
  width: number,
  cap = NODE_CAP,
): ReadonlyMap<string, ReadonlyArray<BranchNode>> {
  for (let spacing = NODE_SPACING; ; spacing *= 2) {
    const result = new Map<string, BranchNode[]>();
    let total = 0;
    for (const strand of workstream.strands) {
      const y = layout.laneY.get(strand.threadId);
      if (y === undefined) continue;
      const nodes = clusterEvents(strand.threadId, strand.events, x, y, width, spacing);
      total += nodes.length;
      result.set(strand.threadId, nodes);
    }
    if (total <= cap || spacing > width) return result;
  }
}
