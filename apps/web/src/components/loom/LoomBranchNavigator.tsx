import { SearchIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Input } from "../ui/input";
import { workstreamColor } from "./loomKinds";
import { formatLoomTime } from "./loomScale";
import type { Weave } from "./loomWeave";

/** Every workstream in the window, most recently active first. Choosing one opens Agent mode. */
export function LoomBranchNavigator(props: {
  readonly weave: Weave;
  readonly currentRootId: string | null;
  readonly onOpen: (rootId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const shown = props.weave.workstreams.filter(
    (workstream) =>
      needle.length === 0 ||
      workstream.strands.some((strand) => strand.title.toLowerCase().includes(needle)),
  );
  return (
    <>
      <div className="shrink-0 border-b border-border/70 px-3 py-2">
        <p className="text-sm font-medium">Branch navigator</p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            size="compact"
            aria-label="Search workstreams"
            placeholder="Search workstreams"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          {needle.length > 0
            ? "No workstreams match this search."
            : "No workstreams in this window."}
        </p>
      ) : (
        <ol aria-label="Workstreams" className="min-h-0 flex-1 overflow-y-auto py-1">
          {shown.map((workstream) => {
            const current = workstream.rootId === props.currentRootId;
            return (
              <li key={workstream.rootId}>
                <button
                  type="button"
                  aria-current={current ? "true" : undefined}
                  className={cn(
                    "flex w-full flex-col gap-0.5 px-3 py-1.5 text-start text-xs hover:bg-accent",
                    current && "bg-accent",
                  )}
                  onClick={() => props.onOpen(workstream.rootId)}
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span
                      aria-hidden
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        workstreamColor(workstream.colorIndex).bg,
                      )}
                    />
                    <span className="truncate text-foreground/90">{workstream.title}</span>
                  </span>
                  <span className="ps-3.5 text-2xs text-muted-foreground">
                    {workstream.agentCount} {workstream.agentCount === 1 ? "agent" : "agents"} ·{" "}
                    {workstream.runCount} {workstream.runCount === 1 ? "run" : "runs"}
                    {workstream.failureCount > 0 ? (
                      <span className="text-destructive"> · {workstream.failureCount} failed</span>
                    ) : null}
                  </span>
                  <span className="ps-3.5 text-2xs text-muted-foreground">
                    {Number.isFinite(workstream.lastActiveMs)
                      ? `Last active ${formatLoomTime(new Date(workstream.lastActiveMs).toISOString())}`
                      : "No activity in this window"}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
