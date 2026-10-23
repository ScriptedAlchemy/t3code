import { loomEdgeLabel, loomMarkerLabel } from "@t3tools/client-runtime/projectLoom";
import type { LoomWindow, RunId, ThreadId } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState, type MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { formatLoomTime } from "./loomScale";
import type { LoomSelection } from "./loomSearch";
import { loomMarkerKey, loomSelectionThread } from "./loomWeave";

export interface LoomActions {
  readonly openThread: (threadId: ThreadId) => void;
  readonly openDiff: (threadId: ThreadId, runId: RunId) => void;
  readonly openPullRequest: (
    event: MouseEvent<HTMLElement>,
    url: string,
    threadId: ThreadId,
  ) => void;
}

interface LoomEvent {
  readonly selection: LoomSelection;
  readonly threadId: ThreadId;
  readonly at: string;
  readonly label: string;
  readonly open: (event: MouseEvent<HTMLElement>) => void;
  readonly openLabel: string;
}

const PAGE = 200;

function loomEvents(data: LoomWindow, actions: LoomActions): ReadonlyArray<LoomEvent> {
  const titleOf = new Map(
    [...data.lanes, ...data.ancestors].map((lane) => [lane.threadId as string, lane.title]),
  );
  const runs = data.runs.map((run): LoomEvent => ({
    selection: { kind: "run", id: run.id },
    threadId: run.threadId,
    at: run.requestedAt,
    label: `Run ${run.ordinal} ${run.status}${run.startedAt === null ? ", start unknown" : ""}`,
    open: () => actions.openThread(run.threadId),
    openLabel: "Open thread",
  }));
  const markers = data.markers.map((marker): LoomEvent => {
    const base = {
      selection: { kind: "marker", id: loomMarkerKey(marker) } as const,
      threadId: marker.threadId,
      at: marker.at,
      label: loomMarkerLabel(marker),
    };
    if (marker.kind === "checkpoint" && marker.runId !== null) {
      const runId = marker.runId;
      return {
        ...base,
        open: () => actions.openDiff(marker.threadId, runId),
        openLabel: "Open diff",
      };
    }
    if (marker.kind === "pull_request") {
      return {
        ...base,
        open: (event) => actions.openPullRequest(event, marker.url, marker.threadId),
        openLabel: "Open pull request",
      };
    }
    return { ...base, open: () => actions.openThread(marker.threadId), openLabel: "Open thread" };
  });
  const edges = data.edges.map((edge): LoomEvent => ({
    selection: { kind: "edge", id: edge.id },
    threadId: edge.targetThreadId,
    at: edge.at,
    label:
      edge.sourceThreadId === edge.targetThreadId
        ? loomEdgeLabel(edge)
        : `${loomEdgeLabel(edge)} from ${titleOf.get(edge.sourceThreadId) ?? "another thread"}`,
    open: () => actions.openThread(edge.targetThreadId),
    openLabel: "Open thread",
  }));
  return [...runs, ...markers, ...edges].toSorted((left, right) => right.at.localeCompare(left.at));
}

/**
 * The accessible reading of the timeline: what is selected and every event in time order,
 * narrowed to the selected lane. Each entry opens its thread, diff or pull request.
 */
export function LoomEventPanel(props: {
  readonly data: LoomWindow;
  readonly selection: LoomSelection | null;
  readonly actions: LoomActions;
  readonly onSelect: (selection: LoomSelection | null) => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  const { data, selection } = props;
  const events = loomEvents(data, props.actions);
  const laneId = loomSelectionThread(data, selection) as ThreadId | null;
  const lane =
    laneId === null ? null : (data.lanes.find((entry) => entry.threadId === laneId) ?? null);
  const laneTitles = new Map(data.lanes.map((entry) => [entry.threadId as string, entry.title]));
  const shown = laneId === null ? events : events.filter((event) => event.threadId === laneId);
  const selected =
    selection === null
      ? null
      : (events.find(
          (event) => event.selection.kind === selection.kind && event.selection.id === selection.id,
        ) ?? null);

  return (
    <aside
      aria-label="Loom events"
      className="flex max-h-[40%] shrink-0 flex-col border-t border-border/70 bg-card/30 lg:max-h-none lg:w-80 lg:border-t-0 lg:border-s"
    >
      <div className="flex shrink-0 items-start gap-2 border-b border-border/70 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {lane?.title ?? (laneId === null ? "All lanes" : "Lane outside this window")}
          </p>
          {lane === null ? null : (
            <p className="truncate text-xs text-muted-foreground">
              {[lane.providerInstanceId, lane.model, lane.branch].filter(Boolean).join(" · ")}
            </p>
          )}
          {selected === null ? null : (
            <p className="mt-1 text-xs text-foreground/90">
              {selected.label}
              <span className="text-muted-foreground"> · {formatLoomTime(selected.at)}</span>
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {laneId === null ? null : (
              <Button size="xs" variant="outline" onClick={() => props.actions.openThread(laneId)}>
                Open thread
              </Button>
            )}
            {selected === null || selected.openLabel === "Open thread" ? null : (
              <Button size="xs" variant="outline" onClick={selected.open}>
                {selected.openLabel}
              </Button>
            )}
          </div>
        </div>
        {selection === null ? null : (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Clear selection"
            onClick={() => props.onSelect(null)}
          >
            <XIcon aria-hidden />
          </Button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">No events in this window.</p>
      ) : (
        <ol aria-label="Events" className="min-h-0 flex-1 overflow-y-auto py-1">
          {shown.slice(0, limit).map((event) => {
            const isSelected =
              selection?.kind === event.selection.kind && selection.id === event.selection.id;
            return (
              <li key={`${event.selection.kind}:${event.selection.id}`}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full flex-col gap-0.5 px-3 py-1.5 text-start text-xs hover:bg-accent",
                    isSelected && "bg-accent",
                  )}
                  onClick={event.open}
                >
                  <span className="line-clamp-2 text-foreground/90">{event.label}</span>
                  <span className="text-2xs text-muted-foreground">
                    {formatLoomTime(event.at)}
                    {laneId === null ? ` · ${laneTitles.get(event.threadId) ?? ""}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
          {shown.length > limit ? (
            <li className="px-3 py-2">
              <Button size="xs" variant="ghost" onClick={() => setLimit(limit + PAGE)}>
                Show {Math.min(PAGE, shown.length - limit)} more
              </Button>
            </li>
          ) : null}
        </ol>
      )}
    </aside>
  );
}
