import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  buildLoomRows,
  groupLoomActivity,
  loomCoverageNotes,
  loomTruncationNotes,
} from "@t3tools/client-runtime/projectLoom";
import {
  LOOM_DEFAULT_WINDOW_MS,
  type EnvironmentId,
  type LoomWindow,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ListFilterIcon,
  ScanIcon,
  SearchIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useDiffPanelStore } from "~/diffPanelStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import { isElectron } from "~/env";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProject } from "~/state/entities";
import { projectLoom } from "~/state/projectLoom";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { LoomEventPanel, type LoomActions } from "./LoomEventPanel";
import { formatLoomTime, type LoomView } from "./loomScale";
import {
  decodeLoomSelection,
  encodeLoomSelection,
  LOOM_STATUS_OPTIONS,
  loomFiltersOf,
  type LoomSearch,
  type LoomSearchPatch,
  type LoomSelection,
} from "./loomSearch";
import { LoomTimeline } from "./LoomTimeline";

const HOUR = 60 * 60 * 1000;
const WINDOW_PRESETS = [
  { label: "24h", ms: 24 * HOUR },
  { label: "7d", ms: LOOM_DEFAULT_WINDOW_MS },
  { label: "30d", ms: 30 * 24 * HOUR },
] as const;

export interface ProjectLoomPageProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly search: LoomSearch;
  readonly onSearchChange: (update: (previous: LoomSearch) => LoomSearch) => void;
}

/** A project's threads and agents over time; the window, filters and selection live in the URL. */
export function ProjectLoomPage(props: ProjectLoomPageProps) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const project = useProject(scopeProjectRef(props.environmentId, props.projectId));
  const supported = config?.environment.capabilities.projectLoom === true;

  const header = (
    <WorkspacePageHeader electron={isElectron}>
      <WorkspaceBreadcrumb ariaLabel="Loom breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem>
          <h1>Loom</h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current className="min-w-10 shrink truncate">
          {project?.title ?? props.projectId}
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
    </WorkspacePageHeader>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {header}
        {config === null ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">Connecting to the environment…</p>
        ) : !supported ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            This environment's server does not have the Loom yet. Update the server to use it.
          </p>
        ) : (
          <LoomWorkspace {...props} />
        )}
      </div>
    </SidebarInset>
  );
}

interface LoomPage {
  readonly cursor: string;
  readonly from: string;
  readonly to: string;
}

function LoomWorkspace(props: ProjectLoomPageProps) {
  const { search, onSearchChange } = props;
  const navigate = useNavigate();
  const openPrLink = useOpenPrLink();
  const filters = loomFiltersOf(search);
  // Lane pages are ephemeral: a cursor only belongs to the project, window and filters that made
  // it. Each page carries the resolved bounds of the page before it, because without explicit
  // bounds the server resolves a new "now" per request and would reject the cursor.
  const filterKey = JSON.stringify([
    props.environmentId,
    props.projectId,
    search.from,
    search.to,
    filters,
  ]);
  const [cursorState, setCursorState] = useState<{
    readonly key: string;
    readonly pages: ReadonlyArray<LoomPage>;
  }>({ key: filterKey, pages: [] });
  const pages = cursorState.key === filterKey ? cursorState.pages : [];
  const setPages = (next: ReadonlyArray<LoomPage>) =>
    setCursorState({ key: filterKey, pages: next });
  const current = pages.at(-1);
  const from = current?.from ?? search.from;
  const to = current?.to ?? search.to;
  const input = {
    projectId: props.projectId,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(filters === undefined ? {} : { filters }),
    ...(current === undefined ? {} : { cursor: current.cursor }),
  };
  const query = useEnvironmentQuery(
    projectLoom.window({ environmentId: props.environmentId, input }),
  );
  const data = query.data;

  const update = useStableCallback((patch: LoomSearchPatch) =>
    onSearchChange((previous) => {
      const next: Record<string, unknown> = { ...previous, ...patch };
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
      return next as LoomSearch;
    }),
  );

  const actions: LoomActions = {
    openThread: (threadId: ThreadId) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
      }),
    openDiff: (threadId: ThreadId, runId: RunId) => {
      const threadRef = scopeThreadRef(props.environmentId, threadId);
      useDiffPanelStore.getState().selectTurn(threadRef, runId);
      useRightPanelStore.getState().open(threadRef, "diff");
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
    },
    openPullRequest: (event, url, threadId) =>
      openPrLink(event, url, scopeThreadRef(props.environmentId, threadId)),
  };

  const shiftWindow = (direction: -1 | 1) => {
    if (data === null) return;
    const fromMs = Date.parse(data.from);
    const toMs = Date.parse(data.to);
    const span = toMs - fromMs;
    update({
      from: new Date(fromMs + direction * span).toISOString(),
      to: new Date(toMs + direction * span).toISOString(),
    });
  };
  const spanMs = data === null ? null : Date.parse(data.to) - Date.parse(data.from);
  const preset = WINDOW_PRESETS.find((option) => option.ms === spanMs);

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2">
        <ToggleGroup
          aria-label="Window"
          variant="segmented"
          value={preset === undefined ? [] : [preset.label]}
          onValueChange={(next) => {
            const option = WINDOW_PRESETS.find((candidate) => candidate.label === next[0]);
            if (option === undefined) return;
            const toMs = data === null ? Date.now() : Date.parse(data.to);
            update({
              from: new Date(toMs - option.ms).toISOString(),
              to: new Date(toMs).toISOString(),
            });
          }}
        >
          {WINDOW_PRESETS.map((option) => (
            <Toggle key={option.label} value={option.label}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button size="icon-sm" variant="ghost" aria-label="Earlier" onClick={() => shiftWindow(-1)}>
          <ChevronLeftIcon aria-hidden />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Later" onClick={() => shiftWindow(1)}>
          <ChevronRightIcon aria-hidden />
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => update({ from: undefined, to: undefined })}
          disabled={search.from === undefined && search.to === undefined}
        >
          Now
        </Button>
        {data === null ? null : (
          <span className="text-xs text-muted-foreground">
            {formatLoomTime(data.from)} to {formatLoomTime(data.to)}
          </span>
        )}
        <div className="ms-auto flex items-center gap-1">
          <LoomFilterControls data={data} search={search} update={update} />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh"
            aria-busy={query.isPending}
            onClick={query.refresh}
          >
            <RefreshIcon size="sm" refreshing={query.isPending} />
          </Button>
        </div>
      </div>
      {data === null ? (
        query.error !== null ? (
          <p role="alert" className="px-5 py-6 text-sm text-destructive">
            {query.error}
          </p>
        ) : (
          <p className="px-5 py-6 text-sm text-muted-foreground">Loading timeline…</p>
        )
      ) : (
        <LoomLoaded
          key={`${data.from}|${data.to}`}
          data={data}
          stale={query.error !== null}
          search={search}
          update={update}
          actions={actions}
          page={pages.length}
          onOlderLanes={
            data.nextCursor === null
              ? null
              : () =>
                  setPages([...pages, { cursor: data.nextCursor!, from: data.from, to: data.to }])
          }
          onNewerLanes={pages.length === 0 ? null : () => setPages(pages.slice(0, -1))}
        />
      )}
    </>
  );
}

function LoomLoaded(props: {
  readonly data: LoomWindow;
  readonly stale: boolean;
  readonly search: LoomSearch;
  readonly update: (patch: LoomSearchPatch) => void;
  readonly actions: LoomActions;
  readonly page: number;
  readonly onOlderLanes: (() => void) | null;
  readonly onNewerLanes: (() => void) | null;
}) {
  const { data, search, update } = props;
  const bounds = { fromMs: Date.parse(data.from), toMs: Date.parse(data.to) };
  const [view, setView] = useState<LoomView>(bounds);
  const [navigatorSearch, setNavigatorSearch] = useState("");
  const collapsed = new Set(search.collapsed ?? []);
  const rows = buildLoomRows(data, collapsed, navigatorSearch);
  const activity = groupLoomActivity(data);
  const visibleRowOf = (() => {
    const rowIndex = new Map(rows.map((row, index) => [row.threadId as string, index]));
    const parentOf = new Map<string, string | null>(
      [...data.lanes, ...data.ancestors].map((lane) => [lane.threadId, lane.parentThreadId]),
    );
    const resolved = new Map<string, number>();
    for (const threadId of parentOf.keys()) {
      let current: string | null | undefined = threadId;
      for (let depth = 0; current != null && depth < 64; depth++) {
        const index = rowIndex.get(current);
        if (index !== undefined) {
          resolved.set(threadId, index);
          break;
        }
        current = parentOf.get(current);
      }
    }
    return resolved;
  })();
  const selection = decodeLoomSelection(search.sel);
  const truncation = [...loomTruncationNotes(data), ...loomCoverageNotes(data)];

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-1.5">
          <div className="flex w-56 items-center gap-1.5">
            <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <Input
              size="compact"
              aria-label="Search lanes"
              placeholder="Search lanes"
              value={navigatorSearch}
              onChange={(event) => setNavigatorSearch(event.currentTarget.value)}
            />
          </div>
          <Button size="xs" variant="ghost" onClick={() => setView(bounds)}>
            <ScanIcon aria-hidden />
            Fit
          </Button>
          <span className="ms-auto text-xs text-muted-foreground" data-testid="loom-as-of">
            {props.stale ? "Could not refresh. " : ""}As of {formatLoomTime(data.asOf)}
          </span>
        </div>
        {truncation.length > 0 || props.stale ? (
          <p
            role="status"
            className="shrink-0 border-b border-border/70 px-3 py-1 text-xs text-muted-foreground"
          >
            {props.stale ? "Showing the last loaded timeline. " : ""}
            {truncation.length > 0 ? `Limited: ${truncation.join(", ")}.` : ""}
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            {navigatorSearch.length > 0
              ? "No lanes match this search."
              : "No thread activity in this window."}
          </p>
        ) : (
          <LoomTimeline
            window={data}
            rows={rows}
            activity={activity}
            visibleRowOf={visibleRowOf}
            view={view}
            bounds={bounds}
            selection={selection}
            onViewChange={setView}
            onSelect={(next: LoomSelection) => update({ sel: encodeLoomSelection(next) })}
            onToggleCollapse={(threadId) => {
              const next = new Set(collapsed);
              if (!next.delete(threadId)) next.add(threadId);
              update({ collapsed: next.size === 0 ? undefined : [...next] });
            }}
          />
        )}
        {props.onOlderLanes === null && props.onNewerLanes === null ? null : (
          <div className="flex shrink-0 items-center gap-2 border-t border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
            <span>Lane page {props.page + 1}</span>
            <Button
              size="xs"
              variant="ghost"
              disabled={props.onNewerLanes === null}
              onClick={props.onNewerLanes ?? undefined}
            >
              Newer lanes
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={props.onOlderLanes === null}
              onClick={props.onOlderLanes ?? undefined}
            >
              Older lanes
            </Button>
          </div>
        )}
      </div>
      <LoomEventPanel
        data={data}
        selection={selection}
        actions={props.actions}
        onSelect={(next) => update({ sel: next === null ? undefined : encodeLoomSelection(next) })}
      />
    </div>
  );
}

function LoomFilterControls(props: {
  readonly data: LoomWindow | null;
  readonly search: LoomSearch;
  readonly update: (patch: LoomSearchPatch) => void;
}) {
  const { search, update } = props;
  // The draft follows the URL whenever the URL's title filter changes underneath it.
  const [draft, setDraft] = useState({ source: search.q, text: search.q ?? "" });
  const title = draft.source === search.q ? draft.text : (search.q ?? "");
  useEffect(() => {
    const trimmed = title.trim();
    if (trimmed === (search.q ?? "")) return;
    const timeout = setTimeout(() => {
      const q = trimmed.length === 0 ? undefined : trimmed;
      // The committed value becomes the draft's source, so a later URL change (Clear, back)
      // replaces the draft even when it returns to an earlier value.
      setDraft({ source: q, text: title });
      update({ q });
    }, 300);
    return () => clearTimeout(timeout);
  }, [title, search.q, update]);

  // Options come from the loaded lanes and runs, plus whatever is already selected.
  const options = (values: Iterable<string>, selected: ReadonlyArray<string> | undefined) =>
    [...new Set([...values, ...(selected ?? [])])].filter(Boolean).toSorted();
  const providers = options(
    (props.data?.runs ?? []).map((run) => run.providerInstanceId),
    search.provider,
  );
  const models = options(
    (props.data?.runs ?? []).map((run) => run.model),
    search.model,
  );
  const branches = options(
    (props.data?.lanes ?? []).flatMap((lane) => (lane.branch === null ? [] : [lane.branch])),
    search.branch,
  );
  const toggle = (values: ReadonlyArray<string> | undefined, value: string, checked: boolean) => {
    const next = new Set(values ?? []);
    if (checked) next.add(value);
    else next.delete(value);
    return next.size === 0 ? undefined : [...next];
  };
  const activeCount =
    (search.status?.length ?? 0) +
    (search.provider?.length ?? 0) +
    (search.model?.length ?? 0) +
    (search.branch?.length ?? 0);

  return (
    <>
      <div className="w-48">
        <Input
          size="compact"
          aria-label="Filter by title"
          placeholder="Filter by title"
          value={title}
          onChange={(event) => setDraft({ source: search.q, text: event.currentTarget.value })}
        />
      </div>
      <Menu>
        <MenuTrigger render={<Button size="xs" variant="ghost-muted" />} aria-label="Filters">
          <ListFilterIcon aria-hidden className="size-3" />
          {activeCount > 0 ? `Filters (${activeCount})` : "Filters"}
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuGroup>
            <MenuGroupLabel>Run status</MenuGroupLabel>
            {LOOM_STATUS_OPTIONS.map((option) => (
              <MenuCheckboxItem
                key={option.value}
                checked={search.status?.includes(option.value) ?? false}
                closeOnClick={false}
                onCheckedChange={(checked) =>
                  update({
                    status: toggle(search.status, option.value, checked) as LoomSearch["status"],
                  })
                }
              >
                {option.label}
              </MenuCheckboxItem>
            ))}
          </MenuGroup>
          {(
            [
              ["Provider", "provider", providers],
              ["Model", "model", models],
              ["Branch", "branch", branches],
            ] as const
          ).map(([label, key, values]) =>
            values.length === 0 ? null : (
              <MenuGroup key={key}>
                <MenuSeparator />
                <MenuGroupLabel>{label}</MenuGroupLabel>
                {values.map((value) => (
                  <MenuCheckboxItem
                    key={value}
                    checked={search[key]?.includes(value) ?? false}
                    closeOnClick={false}
                    onCheckedChange={(checked) =>
                      update({ [key]: toggle(search[key], value, checked) })
                    }
                  >
                    {value}
                  </MenuCheckboxItem>
                ))}
              </MenuGroup>
            ),
          )}
        </MenuPopup>
      </Menu>
      {activeCount > 0 || search.q !== undefined ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            update({
              q: undefined,
              status: undefined,
              provider: undefined,
              model: undefined,
              branch: undefined,
            })
          }
        >
          Clear
        </Button>
      ) : null}
    </>
  );
}
