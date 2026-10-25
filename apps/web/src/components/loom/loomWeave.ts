import {
  buildLoomRows,
  groupLoomActivity,
  type LoomLaneActivity,
} from "@t3tools/client-runtime/projectLoom";
import type { LoomEdge, LoomLane, LoomMarker, LoomRun, LoomWindow } from "@t3tools/contracts";

import type { WeaveEventKind } from "./loomKinds";
import { ACTIVE_RUN, loomActivitySpan } from "./loomScale";
import type { LoomSelection } from "./loomSearch";

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

export interface WeaveEvent {
  readonly key: string;
  readonly ms: number;
  readonly kind: WeaveEventKind;
  /** A failed run, a test with a non-zero exit, or an error tick. */
  readonly failed: boolean;
  /** What clicking the event selects; a plain tick selects its strand. */
  readonly selection: LoomSelection;
  readonly detail: string | null;
}

export type StrandEnd = "completed" | "failed" | "interrupted" | "active" | "unknown";

export interface WeaveStrand {
  readonly threadId: string;
  readonly title: string;
  readonly parentThreadId: string | null;
  readonly rootId: string;
  readonly depth: number;
  /** Null for an ancestor stub that is not on this page. */
  readonly lane: LoomLane | null;
  readonly extent: LaneExtent | null;
  /** Exact when a transfer edge recorded it, inferred from createdAt otherwise. */
  readonly spawn: { readonly ms: number; readonly exact: boolean } | null;
  readonly rejoin: { readonly ms: number; readonly edgeId: string } | null;
  readonly end: StrandEnd;
  /** Oldest first. */
  readonly events: ReadonlyArray<WeaveEvent>;
}

export interface Workstream {
  readonly rootId: string;
  readonly title: string;
  readonly colorIndex: number;
  /** The root first, then its descendants in tree order. */
  readonly strands: ReadonlyArray<WeaveStrand>;
  /** -Infinity when nothing on it happened in the window. */
  readonly lastActiveMs: number;
  readonly agentCount: number;
  readonly runCount: number;
  readonly failureCount: number;
}

export interface Weave {
  /** Most recently active first; colours follow this order. */
  readonly workstreams: ReadonlyArray<Workstream>;
  readonly strands: ReadonlyMap<string, WeaveStrand>;
  readonly asOfMs: number;
  /** Where the window's recorded activity begins: the spindle's start anchor. */
  readonly startMs: number;
  /** Where the loaded record ends: the as-of time, or the window's end when that comes first. */
  readonly tailMs: number;
}

const SPAWN_EDGES = new Set<LoomEdge["type"]>(["subagent_spawn", "fork"]);
const REJOIN_EDGES = new Set<LoomEdge["type"]>([
  "subagent_result",
  "merge_back",
  "provider_handoff",
]);

const RUN_END: Record<LoomRun["status"], StrandEnd> = {
  preparing: "active",
  queued: "active",
  starting: "active",
  running: "active",
  waiting: "active",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
  cancelled: "interrupted",
  rolled_back: "interrupted",
};

function markerEvent(marker: LoomMarker): WeaveEvent | null {
  if (!isLoomEventMarker(marker)) return null;
  const base = {
    key: loomMarkerKey(marker),
    ms: Date.parse(marker.at),
    selection: { kind: "marker", id: loomMarkerKey(marker) } as const,
  };
  switch (marker.kind) {
    case "checkpoint":
      return {
        ...base,
        kind: "checkpoint",
        failed: marker.status === "error",
        detail: `${marker.fileCount} ${marker.fileCount === 1 ? "file" : "files"}`,
      };
    case "test_command":
      return {
        ...base,
        kind: "test",
        failed: marker.exitCode !== null && marker.exitCode !== 0,
        detail: marker.exitCode === null ? marker.command : `exit ${marker.exitCode}`,
      };
    case "pull_request":
      return { ...base, kind: "pull_request", failed: false, detail: `#${marker.number}` };
    case "subagent_task":
      return { ...base, kind: "task", failed: false, detail: marker.title };
  }
}

function strandEvents(threadId: string, activity: LoomLaneActivity | undefined): WeaveEvent[] {
  if (activity === undefined) return [];
  const events: WeaveEvent[] = [];
  const requestedAt = new Map<string, number>();
  for (const run of activity.runs) {
    const ms = Date.parse(run.requestedAt);
    requestedAt.set(run.id, ms);
    const selection = { kind: "run", id: run.id } as const;
    events.push({
      key: `run:${run.id}`,
      ms,
      kind: "run",
      failed: false,
      selection,
      detail: `Run ${run.ordinal}`,
    });
    if (run.status === "failed") {
      events.push({
        key: `failed:${run.id}`,
        ms: run.completedAt === null ? ms : Date.parse(run.completedAt),
        kind: "error",
        failed: true,
        selection,
        detail: `Run ${run.ordinal} failed`,
      });
    }
  }
  for (const marker of activity.markers) {
    const event = markerEvent(marker);
    if (event !== null) events.push(event);
  }
  const selection = { kind: "lane", id: threadId } as const;
  for (const run of activity.activity) {
    const baseMs = requestedAt.get(run.runId);
    if (baseMs === undefined) continue;
    run.ticks.forEach(([offsetMs, kind], index) => {
      events.push({
        key: `tick:${run.runId}:${index}`,
        ms: baseMs + offsetMs,
        kind,
        failed: kind === "error",
        selection,
        detail: null,
      });
    });
  }
  return events.sort((left, right) => left.ms - right.ms);
}

/**
 * The window as workstreams: each root thread with its descendants, every strand with its extent,
 * spawn, rejoin and events. Depends only on the window, so callers memoize it once per load.
 */
export function buildWeave(window: LoomWindow): Weave {
  const asOfMs = Date.parse(window.asOf);
  const activity = groupLoomActivity(window);
  const rows = buildLoomRows(window, new Set());
  const parents = new Map(
    [...window.ancestors, ...window.lanes].map((lane) => [lane.threadId, lane.parentThreadId]),
  );
  const edgeBetween = (
    source: string,
    target: string,
    types: ReadonlySet<LoomEdge["type"]>,
  ): LoomEdge | undefined =>
    window.edges.find(
      (edge) =>
        edge.sourceThreadId === source && edge.targetThreadId === target && types.has(edge.type),
    );

  const strands = new Map<string, WeaveStrand>();
  const groups: WeaveStrand[][] = [];
  let rootId = "";
  for (const row of rows) {
    if (row.depth === 0) {
      rootId = row.threadId;
      groups.push([]);
    }
    const laneActivity = activity.get(row.threadId);
    const parent =
      row.depth === 0 || row.parentMissing ? null : (parents.get(row.threadId) ?? null);
    const spawnEdge = parent === null ? undefined : edgeBetween(parent, row.threadId, SPAWN_EDGES);
    const rejoinEdge =
      parent === null ? undefined : edgeBetween(row.threadId, parent, REJOIN_EDGES);
    const runs = laneActivity?.runs ?? [];
    const lastRun = runs.reduce<LoomRun | null>(
      (latest, run) => (latest === null || run.requestedAt > latest.requestedAt ? run : latest),
      null,
    );
    const spawn =
      spawnEdge !== undefined
        ? { ms: Date.parse(spawnEdge.at), exact: true }
        : parent !== null && row.lane !== null
          ? { ms: Date.parse(row.lane.createdAt), exact: false }
          : null;
    const rejoin =
      rejoinEdge === undefined ? null : { ms: Date.parse(rejoinEdge.at), edgeId: rejoinEdge.id };
    const strand: WeaveStrand = {
      threadId: row.threadId,
      title: row.title,
      parentThreadId: parent,
      rootId,
      depth: row.depth,
      lane: row.lane,
      extent:
        row.lane === null
          ? null
          : withTransfers(laneExtent(row.lane, laneActivity, asOfMs), spawn, rejoin),
      spawn,
      rejoin,
      end: lastRun === null ? "unknown" : RUN_END[lastRun.status],
      events: strandEvents(row.threadId, laneActivity),
    };
    strands.set(strand.threadId, strand);
    groups.at(-1)!.push(strand);
  }

  const workstreams = groups
    .map((group) => {
      const root = group[0]!;
      return {
        rootId: root.threadId,
        title: root.title,
        strands: group,
        lastActiveMs: Math.max(...group.map((strand) => strand.extent?.endMs ?? -Infinity)),
        agentCount: group.length - 1,
        runCount: group.reduce(
          (total, strand) => total + (activity.get(strand.threadId)?.runs.length ?? 0),
          0,
        ),
        failureCount: group.reduce(
          (total, strand) =>
            total +
            strand.events.filter((event) => event.failed && event.selection.kind !== "lane").length,
          0,
        ),
      };
    })
    .sort((left, right) => right.lastActiveMs - left.lastActiveMs)
    .map((workstream, colorIndex) => ({ ...workstream, colorIndex }));
  const fromMs = Date.parse(window.from);
  const tailMs = Math.min(asOfMs, Date.parse(window.to));
  const firstMs = loomActivitySpan(window, { fromMs, toMs: tailMs })?.firstMs ?? fromMs;
  return { workstreams, strands, asOfMs, startMs: Math.min(firstMs, tailMs), tailMs };
}

/**
 * A subagent that recorded no run of its own (a provider-native task, say) still worked from the
 * recorded spawn to the recorded result, so those transfers bound its extent too.
 */
function withTransfers(
  extent: LaneExtent,
  spawn: WeaveStrand["spawn"],
  rejoin: WeaveStrand["rejoin"],
): LaneExtent {
  const exact = [spawn?.exact === true ? spawn.ms : null, rejoin?.ms ?? null].filter(
    (ms): ms is number => ms !== null,
  );
  if (exact.length === 0) return extent;
  return {
    ...extent,
    startMs: Math.min(extent.startMs, ...exact),
    endMs: Math.max(extent.endMs, ...exact),
  };
}

/**
 * Children that recorded nothing but their creation: no run, event or result, and no children of
 * their own. A lane for each would be a curve to nowhere, so they show only as a spawn node on
 * their parent, and get no strand of their own in either mode.
 */
export function quietChildren(workstream: Workstream): ReadonlySet<string> {
  const parents = new Set(workstream.strands.map((strand) => strand.parentThreadId));
  return new Set(
    workstream.strands
      .filter(
        (strand) =>
          strand.parentThreadId !== null &&
          strand.events.length === 0 &&
          strand.rejoin === null &&
          !parents.has(strand.threadId),
      )
      .map((strand) => strand.threadId),
  );
}

/** The workstream to put on the spine: the requested one when loaded, else the most recent. */
export function spineWorkstream(weave: Weave, rootId: string | undefined): Workstream | null {
  return (
    (rootId === undefined ? undefined : weave.workstreams.find((w) => w.rootId === rootId)) ??
    weave.workstreams[0] ??
    null
  );
}

/**
 * Each strand's colour index. Workstreams keep their own colour, except the one on the spine:
 * there each of the root's children takes the next colour and its descendants inherit it, so its
 * branches stay apart and a subagent keeps its colour between Workstream and Agent mode.
 */
export function strandColors(weave: Weave, spine: Workstream | null): ReadonlyMap<string, number> {
  const colors = new Map<string, number>();
  for (const workstream of weave.workstreams) {
    if (workstream !== spine) {
      for (const strand of workstream.strands) colors.set(strand.threadId, workstream.colorIndex);
      continue;
    }
    let next = workstream.colorIndex + 1;
    for (const strand of workstream.strands) {
      const inherited =
        strand.parentThreadId === null || strand.parentThreadId === workstream.rootId
          ? undefined
          : colors.get(strand.parentThreadId);
      colors.set(
        strand.threadId,
        strand.parentThreadId === null ? workstream.colorIndex : (inherited ?? next++),
      );
    }
  }
  return colors;
}

/** The strand a selection belongs to, if any. An edge belongs to the strand it lands on. */
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
