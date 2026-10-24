import type {
  ProjectCodeEdge,
  ProjectCodeQueryResult,
  ProjectCodeSymbol,
  ProjectCodeSymbolSelector,
} from "@t3tools/contracts";

import { GRADE_RANK } from "../files/codeRelationshipRows";

export type ExplorerHops = 1 | 2;
export type ExplorerSide = "callers" | "callees";

// One side's query limit; both sides together stay near the drawn cap.
export const SIDE_LIMIT = 30;
export const NODE_CAP = SIDE_LIMIT * 2;

export interface ExplorerNode {
  readonly symbol: ProjectCodeSymbol;
  readonly side: ExplorerSide | "focus";
  readonly hop: 0 | 1 | 2;
  /** The edge that places this node on its side, toward the focus. */
  readonly via: ExplorerEdge | null;
}

/** Every call site between two drawn symbols, folded into one connector. */
export interface ExplorerEdge {
  readonly key: string;
  readonly source: string;
  readonly target: string;
  readonly grade: ProjectCodeEdge["evidenceGrade"];
  readonly kind: string;
  readonly line: number | null;
  readonly sites: number;
}

export interface ExplorerModel {
  readonly focus: ProjectCodeSymbol;
  readonly callers: ReadonlyArray<ExplorerNode>;
  readonly callees: ReadonlyArray<ExplorerNode>;
  readonly edges: ReadonlyArray<ExplorerEdge>;
  /** Returned symbols this view left out to stay within `NODE_CAP`. */
  readonly omitted: number;
}

export function selectorFor(symbol: ProjectCodeSymbol): ProjectCodeSymbolSelector {
  return { name: symbol.name, filePath: symbol.path, line: symbol.startLine };
}

function foldEdges(results: ReadonlyArray<ProjectCodeQueryResult>): Map<string, ExplorerEdge> {
  const folded = new Map<string, ExplorerEdge>();
  const seenSites = new Set<string>();
  for (const result of results) {
    for (const edge of result.edges) {
      const site = `${edge.source}\0${edge.target}\0${edge.kind}\0${edge.line ?? ""}\0${edge.column ?? ""}`;
      if (seenSites.has(site)) continue;
      seenSites.add(site);
      const key = `${edge.source}\0${edge.target}`;
      const current = folded.get(key);
      if (current === undefined) {
        folded.set(key, {
          key,
          source: edge.source,
          target: edge.target,
          grade: edge.evidenceGrade,
          kind: edge.kind,
          line: edge.line,
          sites: 1,
        });
        continue;
      }
      const stronger = GRADE_RANK[edge.evidenceGrade] < GRADE_RANK[current.grade];
      folded.set(key, {
        ...current,
        grade: stronger ? edge.evidenceGrade : current.grade,
        kind: stronger ? edge.kind : current.kind,
        line: current.line ?? edge.line,
        sites: current.sites + 1,
      });
    }
  }
  return folded;
}

/**
 * Hop distances walked over the returned edges, so a symbol both reached directly and through
 * another caller is placed at hop 1. The SDK reports each symbol once with the first edge its
 * depth-first walk found, which can be the longer route; the depth-1 result restores the short one.
 */
function walkSide(
  side: ExplorerSide,
  focusId: string,
  hops: ExplorerHops,
  edges: ReadonlyArray<ExplorerEdge>,
  symbols: ReadonlyMap<string, ProjectCodeSymbol>,
  claimed: ReadonlySet<string>,
): ExplorerNode[] {
  const placed = new Map<string, ExplorerNode>();
  let frontier = [focusId];
  for (const hop of hops === 1 ? ([1] as const) : ([1, 2] as const)) {
    const reached = new Set(frontier);
    const next: ExplorerNode[] = [];
    for (const edge of edges) {
      const [near, far] =
        side === "callers" ? [edge.target, edge.source] : [edge.source, edge.target];
      if (!reached.has(near) || far === focusId || placed.has(far) || claimed.has(far)) continue;
      const symbol = symbols.get(far);
      if (symbol === undefined) continue;
      const node: ExplorerNode = { symbol, side, hop, via: edge };
      placed.set(far, node);
      next.push(node);
    }
    frontier = next.map((node) => node.symbol.id);
  }
  return [...placed.values()];
}

/**
 * Orders a side for drawing: hop 1 by name, then hop 2 grouped under the hop-1 symbol it hangs
 * from, so connectors between the two columns cross as little as a stable order allows.
 */
function orderSide(side: ExplorerSide, nodes: ReadonlyArray<ExplorerNode>): ExplorerNode[] {
  const first = nodes
    .filter((node) => node.hop === 1)
    .toSorted((left, right) => left.symbol.name.localeCompare(right.symbol.name));
  const rank = new Map(first.map((node, index) => [node.symbol.id, index]));
  const parent = (node: ExplorerNode) =>
    node.via === null
      ? -1
      : (rank.get(side === "callers" ? node.via.target : node.via.source) ?? -1);
  const second = nodes
    .filter((node) => node.hop === 2)
    .toSorted(
      (left, right) =>
        parent(left) - parent(right) || left.symbol.name.localeCompare(right.symbol.name),
    );
  return [...first, ...second];
}

/**
 * The neighbourhood drawn around `focus`: callers on one side, callees on the other, at most two
 * hops out and `NODE_CAP` symbols in all. A symbol on both sides (recursion through another
 * function) is drawn once, as a caller. Results are the depth-1 and, when expanded, depth-2
 * answers for each side; anything returned but not drawn is counted, never silently dropped.
 */
export function buildExplorerModel(input: {
  readonly focus: ProjectCodeSymbol;
  readonly hops: ExplorerHops;
  readonly callers: ReadonlyArray<ProjectCodeQueryResult>;
  readonly callees: ReadonlyArray<ProjectCodeQueryResult>;
}): ExplorerModel {
  const focusId = input.focus.id;
  const symbols = new Map<string, ProjectCodeSymbol>();
  for (const result of [...input.callers, ...input.callees]) {
    for (const node of result.nodes) symbols.set(node.id, node);
  }
  const callerEdges = [...foldEdges(input.callers).values()];
  const calleeEdges = [...foldEdges(input.callees).values()];
  const perSide = Math.floor(NODE_CAP / 2);
  const callersAll = orderSide(
    "callers",
    walkSide("callers", focusId, input.hops, callerEdges, symbols, new Set()),
  );
  const callers = callersAll.slice(0, perSide);
  const calleesAll = orderSide(
    "callees",
    walkSide(
      "callees",
      focusId,
      input.hops,
      calleeEdges,
      symbols,
      new Set(callersAll.map((node) => node.symbol.id)),
    ),
  );
  const callees = calleesAll.slice(0, perSide);
  const drawn = new Set([focusId, ...[...callers, ...callees].map((node) => node.symbol.id)]);
  const edges = [...foldEdges([...input.callers, ...input.callees]).values()].filter(
    (edge) => edge.source !== edge.target && drawn.has(edge.source) && drawn.has(edge.target),
  );
  const returned = new Set(symbols.keys());
  returned.delete(focusId);
  return {
    focus: input.focus,
    callers,
    callees,
    edges,
    omitted: Math.max(0, returned.size - callers.length - callees.length),
  };
}

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 40;
const ROW_GAP = 8;
const COLUMN_GAP = 64;
const PADDING = 12;

export interface PlacedNode {
  readonly node: ExplorerNode;
  readonly x: number;
  readonly y: number;
}

export interface ExplorerLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: ReadonlyArray<PlacedNode>;
  readonly connectors: ReadonlyArray<{ readonly edge: ExplorerEdge; readonly path: string }>;
}

/**
 * Fixed columns, left to right: callers two hops out, direct callers, the focus, direct callees,
 * callees two hops out. Geometry is deterministic so re-centering never reflows into a
 * different picture of the same neighbourhood.
 */
export function layoutExplorer(model: ExplorerModel): ExplorerLayout {
  const focusNode: ExplorerNode = { symbol: model.focus, side: "focus", hop: 0, via: null };
  const columns = [
    model.callers.filter((node) => node.hop === 2),
    model.callers.filter((node) => node.hop === 1),
    [focusNode],
    model.callees.filter((node) => node.hop === 1),
    model.callees.filter((node) => node.hop === 2),
  ].filter((column, index) => index === 2 || column.length > 0);
  const columnHeight = (count: number) => count * NODE_HEIGHT + (count - 1) * ROW_GAP;
  const height = Math.max(...columns.map((column) => columnHeight(column.length))) + PADDING * 2;
  const width = columns.length * NODE_WIDTH + (columns.length - 1) * COLUMN_GAP + PADDING * 2;
  const placed = columns.flatMap((column, columnIndex) => {
    const top = (height - columnHeight(column.length)) / 2;
    return column.map((node, row) => ({
      node,
      x: PADDING + columnIndex * (NODE_WIDTH + COLUMN_GAP),
      y: top + row * (NODE_HEIGHT + ROW_GAP),
    }));
  });
  const byId = new Map(placed.map((entry) => [entry.node.symbol.id, entry]));
  const connectors = model.edges.flatMap((edge) => {
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    if (from === undefined || to === undefined) return [];
    // Calls read left to right. A call back toward the left leaves and enters on the near
    // sides, and a call within one column loops out on its left.
    const startY = from.y + NODE_HEIGHT / 2;
    const endY = to.y + NODE_HEIGHT / 2;
    if (from.x === to.x) {
      const loop = from.x - 32;
      return [
        {
          edge,
          path: `M ${from.x} ${startY} C ${loop} ${startY}, ${loop} ${endY}, ${to.x} ${endY}`,
        },
      ];
    }
    const forward = from.x < to.x;
    const startX = forward ? from.x + NODE_WIDTH : from.x;
    const endX = forward ? to.x : to.x + NODE_WIDTH;
    const bend = Math.max(24, Math.abs(endX - startX) / 2) * (forward ? 1 : -1);
    return [
      {
        edge,
        path: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
      },
    ];
  });
  return { width, height, nodes: placed, connectors };
}
