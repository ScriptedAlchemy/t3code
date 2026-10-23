import type { LoomLaneActivity } from "@t3tools/client-runtime/projectLoom";
import type {
  LoomActivityKind,
  LoomLane,
  LoomMarker,
  LoomRun,
  LoomRunActivity,
  LoomWindow,
} from "@t3tools/contracts";

import type { LoomView } from "./loomScale";
import type { LoomSelection } from "./loomSearch";

export const ACTIVE_RUN = new Set<LoomRun["status"]>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export const loomMarkerKey = (marker: Pick<LoomMarker, "kind" | "id">) =>
  `${marker.kind}:${marker.id}`;

/**
 * A ready checkpoint with no changed files is the bookkeeping every turn ends with, not an event
 * worth a glyph or a list entry.
 */
export function isLoomEventMarker(marker: LoomMarker): boolean {
  return !(marker.kind === "checkpoint" && marker.fileCount === 0 && marker.status === "ready");
}

export interface LaneExtent {
  readonly startMs: number;
  readonly endMs: number;
  readonly active: boolean;
}

/** When a lane's lifeline begins and ends: its own creation plus everything recorded on it. */
export function laneExtent(
  lane: Pick<LoomLane, "createdAt" | "archivedAt">,
  activity: LoomLaneActivity | undefined,
  asOfMs: number,
): LaneExtent {
  let startMs = Date.parse(lane.createdAt);
  let endMs = startMs;
  let active = false;
  const include = (ms: number) => {
    if (ms < startMs) startMs = ms;
    if (ms > endMs) endMs = ms;
  };
  const requestedAt = new Map<string, number>();
  for (const run of activity?.runs ?? []) {
    const requestedMs = Date.parse(run.requestedAt);
    requestedAt.set(run.id, requestedMs);
    include(requestedMs);
    if (run.startedAt !== null) include(Date.parse(run.startedAt));
    if (run.completedAt !== null) include(Date.parse(run.completedAt));
    else if (ACTIVE_RUN.has(run.status)) {
      active = true;
      include(asOfMs);
    }
  }
  for (const marker of activity?.markers ?? []) {
    include(Date.parse(marker.at));
    if ("completedAt" in marker && marker.completedAt !== null) {
      include(Date.parse(marker.completedAt));
    }
  }
  for (const run of activity?.activity ?? []) {
    const baseMs = requestedAt.get(run.runId);
    if (baseMs === undefined) continue;
    for (const [offsetMs] of run.ticks) include(baseMs + offsetMs);
  }
  if (lane.archivedAt !== null) {
    const archivedMs = Date.parse(lane.archivedAt);
    if (archivedMs < endMs) endMs = Math.max(archivedMs, startMs);
    active = false;
  }
  return { startMs, endMs, active };
}

/** Rail thickness in px, growing with the log of how much happened on the lane. */
export function railThickness(eventCount: number): number {
  return Math.min(7, 2 + Math.log2(1 + eventCount) * 0.6);
}

/** Lanes whose last activity is older fade toward the start of the window. */
export function recencyOpacity(endMs: number, bounds: LoomView): number {
  const span = bounds.toMs - bounds.fromMs;
  const t = span <= 0 ? 1 : (endMs - bounds.fromMs) / span;
  return 0.45 + 0.55 * Math.min(1, Math.max(0, t));
}

// When ticks of several kinds share a pixel column, the most telling one colours it.
const KIND_PRIORITY: Record<LoomActivityKind, number> = {
  error: 5,
  edit: 4,
  command: 3,
  tool: 2,
  user: 1,
  agent: 0,
};

export const LOOM_ACTIVITY_KINDS: ReadonlyArray<LoomActivityKind> = [
  "user",
  "agent",
  "command",
  "edit",
  "tool",
  "error",
];

export interface TickBin {
  readonly column: number;
  readonly kind: LoomActivityKind;
  readonly count: number;
}

/** Ticks bucketed into whole pixel columns of the view, ordered left to right. */
export function binTicks(
  activity: ReadonlyArray<LoomRunActivity>,
  runsById: ReadonlyMap<string, Pick<LoomRun, "requestedAt">>,
  scale: { readonly x: (ms: number) => number },
  width: number,
): ReadonlyArray<TickBin> {
  const bins = new Map<number, { kind: LoomActivityKind; count: number }>();
  for (const run of activity) {
    const requested = runsById.get(run.runId);
    if (requested === undefined) continue;
    const baseMs = Date.parse(requested.requestedAt);
    for (const [offsetMs, kind] of run.ticks) {
      const column = Math.floor(scale.x(baseMs + offsetMs));
      if (column < 0 || column >= width) continue;
      const bin = bins.get(column);
      if (bin === undefined) bins.set(column, { kind, count: 1 });
      else {
        bin.count += 1;
        if (KIND_PRIORITY[kind] > KIND_PRIORITY[bin.kind]) bin.kind = kind;
      }
    }
  }
  return [...bins]
    .map(([column, bin]) => ({ column, kind: bin.kind, count: bin.count }))
    .toSorted((left, right) => left.column - right.column);
}

/**
 * One path per kind, so thousands of ticks stay a handful of elements. A busier column draws a
 * slightly taller tick.
 */
export function tickPaths(
  bins: ReadonlyArray<TickBin>,
  mid: number,
  halfHeight: number,
): ReadonlyMap<LoomActivityKind, string> {
  const parts = new Map<LoomActivityKind, Array<string>>();
  for (const bin of bins) {
    const half = halfHeight + Math.min(3, Math.log2(bin.count));
    const x = bin.column + 0.5;
    const segment = `M${x} ${(mid - half).toFixed(1)}V${(mid + half).toFixed(1)}`;
    const list = parts.get(bin.kind);
    if (list === undefined) parts.set(bin.kind, [segment]);
    else list.push(segment);
  }
  return new Map([...parts].map(([kind, segments]) => [kind, segments.join("")]));
}

/** The lane a selection belongs to, if any. An edge belongs to the lane it lands on. */
export function loomSelectionThread(
  window: Pick<LoomWindow, "runs" | "markers" | "edges">,
  selection: LoomSelection | null,
): string | null {
  if (selection === null) return null;
  switch (selection.kind) {
    case "lane":
      return selection.id;
    case "run":
      return window.runs.find((run) => run.id === selection.id)?.threadId ?? null;
    case "marker":
      return (
        window.markers.find((marker) => loomMarkerKey(marker) === selection.id)?.threadId ?? null
      );
    case "edge":
      return window.edges.find((edge) => edge.id === selection.id)?.targetThreadId ?? null;
  }
}

/** A lane with every ancestor above it and every descendant below it, but no siblings. */
export function loomChain(
  window: Pick<LoomWindow, "lanes" | "ancestors">,
  threadId: string,
): ReadonlySet<string> {
  const parentOf = new Map<string, string | null>();
  const childrenOf = new Map<string, Array<string>>();
  for (const lane of [...window.ancestors, ...window.lanes]) {
    parentOf.set(lane.threadId, lane.parentThreadId);
    if (lane.parentThreadId === null) continue;
    const siblings = childrenOf.get(lane.parentThreadId);
    if (siblings === undefined) childrenOf.set(lane.parentThreadId, [lane.threadId]);
    else siblings.push(lane.threadId);
  }
  const chain = new Set<string>([threadId]);
  for (let parent = parentOf.get(threadId); parent != null && !chain.has(parent);) {
    chain.add(parent);
    parent = parentOf.get(parent);
  }
  const pending = [threadId];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    for (const child of childrenOf.get(current) ?? []) {
      if (chain.has(child)) continue;
      chain.add(child);
      pending.push(child);
    }
  }
  return chain;
}

export const HISTOGRAM_BIN_PX = 3;

/** Ticks and run requests counted into ~3px bins across the window bounds. */
export function activityHistogram(
  window: Pick<LoomWindow, "runs" | "activity">,
  bounds: LoomView,
  width: number,
): ReadonlyArray<number> {
  const binCount = Math.max(1, Math.floor(width / HISTOGRAM_BIN_PX));
  const counts = Array.from({ length: binCount }, () => 0);
  const span = bounds.toMs - bounds.fromMs;
  if (span <= 0) return counts;
  const add = (ms: number) => {
    if (ms < bounds.fromMs || ms > bounds.toMs) return;
    const bin = Math.min(binCount - 1, Math.floor(((ms - bounds.fromMs) / span) * binCount));
    counts[bin]! += 1;
  };
  const requestedAt = new Map<string, number>();
  for (const run of window.runs) {
    const ms = Date.parse(run.requestedAt);
    requestedAt.set(run.id, ms);
    add(ms);
  }
  for (const run of window.activity) {
    const baseMs = requestedAt.get(run.runId);
    if (baseMs === undefined) continue;
    for (const [offsetMs] of run.ticks) add(baseMs + offsetMs);
  }
  return counts;
}

/** The histogram as one filled path, bars scaled by sqrt so a single tick stays visible. */
export function histogramPath(
  counts: ReadonlyArray<number>,
  width: number,
  height: number,
): string {
  const max = Math.max(0, ...counts);
  if (max === 0) return "";
  const binWidth = width / counts.length;
  let d = "";
  counts.forEach((count, index) => {
    if (count === 0) return;
    const barHeight = Math.max(1.5, Math.sqrt(count / max) * height);
    const x = index * binWidth;
    d += `M${x.toFixed(1)} ${height}V${(height - barHeight).toFixed(1)}H${(x + binWidth - 0.5).toFixed(1)}V${height}Z`;
  });
  return d;
}
