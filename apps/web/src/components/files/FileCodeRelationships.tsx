import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectCodeCoverage,
  ProjectCodeEdge,
  ProjectCodeQueryResult,
  ProjectCodeSymbol,
  ProjectId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useRightPanelStore } from "~/rightPanelStore";
import { useQuietThreadShell } from "~/state/entities";
import { projectCode } from "~/state/projectCode";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { cn } from "~/lib/utils";

// Each section is one bounded page; the panel is a pointer into source, not a graph browser.
const RESULT_LIMIT = 50;

type RelationMode = "callers" | "references" | "impact";

interface Location {
  readonly key: string;
  readonly label: string;
  readonly path: string;
  readonly line: number;
  readonly detail: string | null;
  readonly isTest: boolean;
}

const GRADE_RANK: Record<ProjectCodeEdge["evidenceGrade"], number> = {
  "compiler-indexed": 0,
  "static-candidate": 1,
  "heuristic-candidate": 2,
};
const GRADE_LABEL: Record<ProjectCodeEdge["evidenceGrade"], string> = {
  "compiler-indexed": "compiler indexed",
  "static-candidate": "static candidate",
  "heuristic-candidate": "heuristic",
};

const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|[._-](test|spec)\.[^/]+$|_test\.[^/]+$/;

/**
 * Callers and references are one row per use site, at the use's line when the
 * index has it. Impact is one row per affected file, likely tests first.
 */
function relationLocations(
  mode: RelationMode,
  result: ProjectCodeQueryResult,
  selectedId: string,
): ReadonlyArray<Location> {
  const nodes = new Map(result.nodes.map((node) => [node.id, node]));
  if (mode === "impact") {
    const strongest = new Map<string, ProjectCodeEdge["evidenceGrade"]>();
    for (const edge of result.edges) {
      const path = nodes.get(edge.source)?.path;
      if (path === undefined) continue;
      const current = strongest.get(path);
      if (current === undefined || GRADE_RANK[edge.evidenceGrade] < GRADE_RANK[current]) {
        strongest.set(path, edge.evidenceGrade);
      }
    }
    const byFile = new Map<string, { line: number; count: number }>();
    for (const node of result.nodes) {
      if (node.id === selectedId) continue;
      const entry = byFile.get(node.path);
      if (entry === undefined) byFile.set(node.path, { line: node.startLine, count: 1 });
      else
        byFile.set(node.path, {
          line: Math.min(entry.line, node.startLine),
          count: entry.count + 1,
        });
    }
    return [...byFile]
      .map(([path, { line, count }]) => {
        const grade = strongest.get(path);
        return {
          key: path,
          label: path,
          path,
          line,
          detail: `${count} ${count === 1 ? "symbol" : "symbols"}${grade ? ` · ${GRADE_LABEL[grade]}` : ""}`,
          isTest: TEST_PATH.test(path),
        };
      })
      .toSorted((left, right) =>
        left.isTest === right.isTest ? left.path.localeCompare(right.path) : left.isTest ? -1 : 1,
      );
  }
  const seen = new Set<string>();
  const locations: Location[] = [];
  for (const edge of result.edges) {
    if (edge.source === selectedId) continue;
    const source = nodes.get(edge.source);
    if (source === undefined) continue;
    const line = edge.line ?? source.startLine;
    const key = `${source.id}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push({
      key,
      label: source.name,
      path: source.path,
      line,
      detail: GRADE_LABEL[edge.evidenceGrade],
      isTest: TEST_PATH.test(source.path),
    });
  }
  return locations;
}

function coverageSummary(coverage: ProjectCodeCoverage): string {
  switch (coverage.state) {
    case "complete":
      return `Static candidates · ${coverage.filesIndexed} files indexed`;
    case "partial":
      return `Static candidates · partial coverage, ${coverage.filesIndexed} of ${coverage.filesListed} files indexed`;
    case "stale":
      return "Stale · some returned files changed since indexing. Verify in source.";
    case "unavailable":
      return "The code index is unavailable for this checkout.";
  }
}

function CoverageNote(props: { readonly coverage: ProjectCodeCoverage }) {
  const { coverage } = props;
  const warn = coverage.state === "stale" || coverage.state === "unavailable";
  return (
    <details className="px-2 text-2xs text-muted-foreground">
      <summary className={cn("cursor-pointer select-none", warn && "text-warning-foreground")}>
        {coverageSummary(coverage)}
      </summary>
      <ul className="mt-1 flex list-disc flex-col gap-0.5 ps-4">
        {coverage.limitations.map((limitation) => (
          <li key={limitation}>{limitation}</li>
        ))}
      </ul>
    </details>
  );
}

function LocationRow(props: {
  readonly label: string;
  readonly location: string;
  readonly detail: string | null;
  readonly pressed?: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      onClick={props.onOpen}
      className={cn(
        "flex w-full min-w-0 items-baseline gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        props.pressed && "bg-accent",
      )}
    >
      <span className="min-w-0 truncate font-mono text-foreground">{props.label}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{props.location}</span>
      {props.detail ? (
        <span className="shrink-0 text-2xs text-muted-foreground">{props.detail}</span>
      ) : null}
    </button>
  );
}

function QueryState(props: {
  readonly pending: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
}) {
  if (props.error !== null) {
    return (
      <div role="alert" className="flex items-center gap-2 px-2 py-1 text-xs text-destructive">
        <span className="min-w-0 flex-1">{props.error}</span>
        <Button variant="ghost-muted" size="micro" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (props.pending) {
    return (
      <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
        Indexing… the first query on a checkout can take a while.
      </p>
    );
  }
  return null;
}

const EMPTY_RELATION: Record<RelationMode, string> = {
  callers: "No static callers found. That does not prove nothing calls it.",
  references: "No static references found. That does not prove it is unused.",
  impact: "No other files found in its static impact radius.",
};

function RelationResults(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadRef: ScopedThreadRef;
  readonly symbol: ProjectCodeSymbol;
}) {
  const [mode, setMode] = useState<RelationMode>("callers");
  const symbol = {
    name: props.symbol.name,
    filePath: props.symbol.path,
    line: props.symbol.startLine,
  };
  const relation = useEnvironmentQuery(
    projectCode.query({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        threadId: props.threadRef.threadId,
        query: { operation: mode, symbol, limit: RESULT_LIMIT },
      },
    }),
  );
  const data = relation.data;
  const locations = data ? relationLocations(mode, data, props.symbol.id) : [];
  return (
    <div className="flex flex-col gap-1 border-t border-border/60 pt-1">
      <ToggleGroup
        aria-label={`Relationships of ${props.symbol.name}`}
        className="mx-2"
        value={[mode]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "callers" || value === "references" || value === "impact") setMode(value);
        }}
      >
        <Toggle value="callers">Callers</Toggle>
        <Toggle value="references">References</Toggle>
        <Toggle value="impact">Impact</Toggle>
      </ToggleGroup>
      {data === null ? (
        <QueryState pending error={relation.error} onRetry={relation.refresh} />
      ) : data.selection.state === "ambiguous" ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {data.selection.candidates.length} symbols match this name here; the index cannot tell
          which one you mean.
        </p>
      ) : data.selection.state === "not-found" ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          This symbol is no longer in the index. Refresh after saving the file.
        </p>
      ) : (
        <>
          <CoverageNote coverage={data.coverage} />
          {locations.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">{EMPTY_RELATION[mode]}</p>
          ) : (
            locations.map((location) => (
              <LocationRow
                key={location.key}
                label={mode === "impact" ? (location.isTest ? "test" : "file") : location.label}
                location={mode === "impact" ? location.path : `${location.path}:${location.line}`}
                detail={location.detail}
                onOpen={() =>
                  useRightPanelStore
                    .getState()
                    .openFile(props.threadRef, location.path, location.line)
                }
              />
            ))
          )}
        </>
      )}
    </div>
  );
}

function RelationshipsBody(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly relativePath: string;
}) {
  const [selected, setSelected] = useState<ProjectCodeSymbol | null>(null);
  const outline = useEnvironmentQuery(
    projectCode.query({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        threadId: props.threadId,
        query: { operation: "symbols", filePath: props.relativePath, limit: RESULT_LIMIT },
      },
    }),
  );
  const data = outline.data;
  return (
    <ScrollArea className="max-h-72" scrollFade>
      <div className="flex flex-col gap-1 pb-2">
        {data === null ? (
          <QueryState pending error={outline.error} onRetry={outline.refresh} />
        ) : (
          <>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <CoverageNote coverage={data.coverage} />
              </div>
              <Button
                variant="ghost-muted"
                size="micro"
                disabled={outline.isPending}
                onClick={outline.refresh}
              >
                Refresh
              </Button>
            </div>
            {data.nodes.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                No indexed declarations in this file. Its language may be unsupported, or it
                declares nothing the index recognizes.
              </p>
            ) : (
              <div role="list" aria-label="Symbols in this file" className="flex flex-col">
                {data.nodes.map((node) => (
                  <div role="listitem" key={node.id}>
                    <LocationRow
                      label={node.name}
                      location={`${node.kind} · line ${node.startLine}`}
                      detail={node.isExported ? "exported" : null}
                      pressed={selected?.id === node.id}
                      onOpen={() => {
                        setSelected(selected?.id === node.id ? null : node);
                        useRightPanelStore
                          .getState()
                          .openFile(props.threadRef, props.relativePath, node.startLine);
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
            {selected !== null && data.nodes.some((node) => node.id === selected.id) ? (
              <RelationResults
                key={selected.id}
                environmentId={props.environmentId}
                projectId={props.projectId}
                threadRef={props.threadRef}
                symbol={selected}
              />
            ) : null}
          </>
        )}
      </div>
    </ScrollArea>
  );
}

/**
 * On-demand symbol relationships for the open file. Nothing is queried until
 * the section is expanded, so indexing never delays the preview itself.
 */
export function FileCodeRelationships(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly relativePath: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canQuery = useAtomValue(projectCode.query.permissionAtom(props.environmentId));
  const thread = useQuietThreadShell(props.threadRef);
  const [expanded, setExpanded] = useState(false);
  if (config?.environment.capabilities.projectCode !== true || !canQuery || thread === null) {
    return null;
  }
  return (
    <section aria-label="Code relationships" className="shrink-0 border-t border-border/60 px-1">
      <CollapsibleSectionHeader
        variant="panel"
        expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        Code relationships
      </CollapsibleSectionHeader>
      {expanded ? (
        <RelationshipsBody
          environmentId={props.environmentId}
          projectId={thread.projectId}
          threadRef={props.threadRef}
          threadId={thread.id}
          relativePath={props.relativePath}
        />
      ) : null}
    </section>
  );
}
