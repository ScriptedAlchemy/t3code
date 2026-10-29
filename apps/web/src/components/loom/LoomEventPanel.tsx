import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  loomEdgeLabel,
  loomMarkerLabel,
  loomMarkerThreadRef,
} from "@t3tools/client-runtime/projectLoom";
import type {
  EnvironmentId,
  LoomWindow,
  RunId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatLoomTime } from "./loomScale";
import type { LoomSelection } from "./loomSearch";
import { loomMarkerKey, loomSelectionThread } from "./loomWeave";

export interface LoomActions {
  readonly canOpenThread: (target: ScopedThreadRef) => boolean;
  readonly openThread: (target: ScopedThreadRef) => void;
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
  readonly unavailable?: string;
}

const PAGE = 200;

function loomEvents(
  data: LoomWindow,
  environmentId: EnvironmentId,
  actions: LoomActions,
): ReadonlyArray<LoomEvent> {
  const titleOf = new Map(
    [...data.lanes, ...data.ancestors].map((lane) => [lane.threadId as string, lane.title]),
  );
  const runs = data.runs.map((run): LoomEvent => ({
    selection: { kind: "run", id: run.id },
    threadId: run.threadId,
    at: run.requestedAt,
    label: `Run ${run.ordinal} ${run.status}${run.startedAt === null ? ", start unknown" : ""}`,
    open: () => actions.openThread(scopeThreadRef(environmentId, run.threadId)),
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
    const target = loomMarkerThreadRef(environmentId, marker);
    const remoteChild = marker.kind === "subagent_task" ? marker.remoteChild : undefined;
    return {
      ...base,
      open: () => actions.openThread(target),
      openLabel: remoteChild !== undefined ? "Open remote task" : "Open thread",
      ...(actions.canOpenThread(target)
        ? {}
        : {
            unavailable: `Connect to ${remoteChild?.label ?? target.environmentId} to open this thread.`,
          }),
    };
  });
  const edges = data.edges.map((edge): LoomEvent => ({
    selection: { kind: "edge", id: edge.id },
    threadId: edge.targetThreadId,
    at: edge.at,
    label:
      edge.sourceThreadId === edge.targetThreadId
        ? loomEdgeLabel(edge)
        : `${loomEdgeLabel(edge)} from ${titleOf.get(edge.sourceThreadId) ?? "another thread"}`,
    open: () => actions.openThread(scopeThreadRef(environmentId, edge.targetThreadId)),
    openLabel: "Open thread",
  }));
  return [...runs, ...markers, ...edges].toSorted((left, right) => right.at.localeCompare(left.at));
}

const ASIDE_CLASS =
  "flex max-h-[40%] shrink-0 flex-col border-t border-border/70 bg-card/30 lg:max-h-none lg:w-80 lg:border-t-0 lg:border-s";

/**
 * The accessible reading of the timeline: what is selected and every event in time order,
 * narrowed to the selected lane. Each entry opens its thread, diff or pull request. With nothing
 * selected the panel shows `navigator` instead.
 */
export function LoomEventPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly data: LoomWindow;
  readonly selection: LoomSelection | null;
  readonly actions: LoomActions;
  readonly navigator: ReactNode;
  readonly onSelect: (selection: LoomSelection | null) => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  const { data, selection } = props;
  if (selection === null) {
    return (
      <aside aria-label="Loom navigator" className={ASIDE_CLASS}>
        {props.navigator}
      </aside>
    );
  }
  const events = loomEvents(data, props.environmentId, props.actions);
  const laneId = loomSelectionThread(data, selection) as ThreadId | null;
  const lane =
    laneId === null ? null : (data.lanes.find((entry) => entry.threadId === laneId) ?? null);
  const identity = lane ?? data.ancestors.find((entry) => entry.threadId === laneId);
  const delegatedFrom = identity?.delegatedFrom;
  const parentAvailable = delegatedFrom === undefined || props.actions.canOpenThread(delegatedFrom);
  const laneTitles = new Map(data.lanes.map((entry) => [entry.threadId as string, entry.title]));
  const shown = laneId === null ? events : events.filter((event) => event.threadId === laneId);
  const selected =
    selection === null
      ? null
      : (events.find(
          (event) => event.selection.kind === selection.kind && event.selection.id === selection.id,
        ) ?? null);

  return (
    <aside aria-label="Loom events" className={ASIDE_CLASS}>
      <div className="flex shrink-0 items-start gap-2 border-b border-border/70 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {identity?.title ?? (laneId === null ? "Selection" : "Lane outside this window")}
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
          {delegatedFrom === undefined ? null : (
            <p className="mt-1 text-xs text-muted-foreground">
              Delegated from {delegatedFrom.title} on {delegatedFrom.environmentId}
            </p>
          )}
          {selected?.unavailable === undefined ? null : (
            <p className="mt-1 text-xs text-muted-foreground">{selected.unavailable}</p>
          )}
          {parentAvailable || delegatedFrom === undefined ? null : (
            <p className="mt-1 text-xs text-muted-foreground">
              Connect to {delegatedFrom.environmentId} to open this parent.
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {laneId === null ? null : (
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  props.actions.openThread(scopeThreadRef(props.environmentId, laneId))
                }
              >
                Open thread
              </Button>
            )}
            {delegatedFrom === undefined ? null : (
              <Button
                size="xs"
                variant="outline"
                disabled={!parentAvailable}
                aria-label={`Open parent thread ${delegatedFrom.title} on ${delegatedFrom.environmentId}`}
                onClick={() =>
                  props.actions.openThread(
                    scopeThreadRef(delegatedFrom.environmentId, delegatedFrom.threadId),
                  )
                }
              >
                Open parent thread
              </Button>
            )}
            {selected === null || selected.openLabel === "Open thread" ? null : (
              <Button
                size="xs"
                variant="outline"
                onClick={selected.open}
                disabled={selected.unavailable !== undefined}
              >
                {selected.openLabel}
              </Button>
            )}
          </div>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Back to navigator"
          onClick={() => props.onSelect(null)}
        >
          <XIcon aria-hidden />
        </Button>
      </div>
      {shown.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">No events in this window.</p>
      ) : (
        <ol aria-label="Events" className="min-h-0 flex-1 overflow-y-auto py-1">
          {shown.slice(0, limit).map((event) => {
            const isSelected =
              selection?.kind === event.selection.kind && selection.id === event.selection.id;
            const button = (
              <button
                type="button"
                className={cn(
                  "flex w-full flex-col gap-0.5 px-3 py-1.5 text-start text-xs hover:bg-accent",
                  isSelected && "bg-accent",
                )}
                onClick={event.open}
                disabled={event.unavailable !== undefined}
              >
                <span className="line-clamp-2 text-foreground/90">{event.label}</span>
                <span className="text-2xs text-muted-foreground">
                  {formatLoomTime(event.at)}
                  {laneId === null ? ` · ${laneTitles.get(event.threadId) ?? ""}` : ""}
                </span>
              </button>
            );
            return (
              <li key={`${event.selection.kind}:${event.selection.id}`}>
                {event.unavailable === undefined ? (
                  button
                ) : (
                  <Tooltip>
                    <TooltipTrigger render={<span className="block" tabIndex={0} />}>
                      {button}
                    </TooltipTrigger>
                    <TooltipPopup>{event.unavailable}</TooltipPopup>
                  </Tooltip>
                )}
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
