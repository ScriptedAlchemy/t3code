import {
  buildLoomRows,
  groupLoomActivity,
  type LoomRow,
} from "@t3tools/client-runtime/projectLoom";
import type { LoomAncestor, LoomMarker, LoomRun, LoomWindow } from "@t3tools/contracts";

export type LoomActivityListItem =
  | { readonly kind: "date"; readonly key: string; readonly date: string }
  | { readonly kind: "thread"; readonly key: string; readonly row: LoomRow }
  | { readonly kind: "run"; readonly key: string; readonly depth: number; readonly run: LoomRun }
  | {
      readonly kind: "marker";
      readonly key: string;
      readonly depth: number;
      readonly marker: LoomMarker;
    };

function loomActivityDate(at: string): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Repeat ancestry on each active date, rather than separating a child from its parent. */
export function buildLoomActivityList(
  window: LoomWindow,
  collapsed: ReadonlySet<string>,
): ReadonlyArray<LoomActivityListItem> {
  const activity = groupLoomActivity(window);
  const dates = new Map<string, Set<string>>();
  const dateOf = (at: string) => loomActivityDate(at < window.from ? window.from : at);
  const add = (at: string, threadId: string) => {
    const date = dateOf(at);
    const threads = dates.get(date) ?? new Set<string>();
    threads.add(threadId);
    dates.set(date, threads);
  };
  for (const run of window.runs) add(run.requestedAt, run.threadId);
  for (const marker of window.markers) add(marker.at, marker.threadId);
  for (const lane of window.lanes) {
    if (!activity.has(lane.threadId)) {
      add(lane.createdAt, lane.threadId);
    }
  }
  const identities = new Map<string, LoomAncestor>(
    [...window.ancestors, ...window.lanes].map((lane) => [lane.threadId, lane]),
  );
  const items: LoomActivityListItem[] = [];
  for (const date of [...dates.keys()].sort((left, right) => right.localeCompare(left))) {
    const activeIds = dates.get(date)!;
    const parents = new Set<string>();
    for (const id of activeIds) {
      let parentId = identities.get(id)?.parentThreadId;
      const visited = new Set<string>([id]);
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        parents.add(parentId);
        parentId = identities.get(parentId)?.parentThreadId;
      }
    }
    const rows = buildLoomRows(
      {
        lanes: window.lanes.filter((lane) => activeIds.has(lane.threadId)),
        ancestors: [...identities.values()].filter(
          (lane) => parents.has(lane.threadId) && !activeIds.has(lane.threadId),
        ),
      },
      collapsed,
    );
    items.push({ kind: "date", key: `date:${date}`, date });
    for (const row of rows) {
      items.push({ kind: "thread", key: `${date}:thread:${row.threadId}`, row });
      const ownActivity = activity.get(row.threadId);
      const events: Array<{ at: string; item: LoomActivityListItem }> = [];
      for (const run of ownActivity?.runs ?? []) {
        if (dateOf(run.requestedAt) !== date) continue;
        events.push({
          at: run.requestedAt,
          item: { kind: "run", key: `${date}:run:${run.id}`, depth: row.depth, run },
        });
      }
      for (const marker of ownActivity?.markers ?? []) {
        if (dateOf(marker.at) !== date) continue;
        events.push({
          at: marker.at,
          item: {
            kind: "marker",
            key: `${date}:${marker.kind}:${marker.id}`,
            depth: row.depth,
            marker,
          },
        });
      }
      for (const event of events.sort((left, right) => left.at.localeCompare(right.at))) {
        items.push(event.item);
      }
    }
  }
  return items;
}
