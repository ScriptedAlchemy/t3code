import "../../index.css";
import { RegistryContext } from "@effect/atom-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ProjectCodeQueryInput,
  type ProjectCodeQueryResult,
  type ProjectCodeSymbol,
  type PullRequestDetailView,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  queries: [] as Array<{ environmentId: string; input: unknown }>,
  results: new Map<string, unknown>(),
  shells: [] as unknown[],
}));
vi.mock(
  import("../../state/server"),
  () =>
    ({
      serverEnvironment: {
        configValueAtom: () => Atom.make({ environment: { capabilities: { projectCode: true } } }),
      },
    }) as never,
);
vi.mock(
  import("../../state/projectCode"),
  () =>
    ({
      projectCode: {
        query: Object.assign(
          (target: { environmentId: string; input: ProjectCodeQueryInput }) => {
            state.queries.push(target);
            return (
              state.results.get(target.input.query.operation) ??
              Atom.make(AsyncResult.initial(true))
            );
          },
          { permissionAtom: () => Atom.make(true) },
        ),
        freshness: Object.assign(
          () => state.results.get("freshness") ?? Atom.make(AsyncResult.initial(true)),
          { permissionAtom: () => Atom.make(true) },
        ),
      },
    }) as never,
);
vi.mock(
  import("../../state/entities"),
  () => ({ useThreadShellsForProjectRefs: () => state.shells }) as never,
);

import { PullRequestImpactPanel } from "./PullRequestImpactPanel";

const environmentId = EnvironmentId.make("pr-impact");
const projectId = ProjectId.make("project");
const reference = { projectId, repository: "acme/app", number: 7 };
const detail = { headBranch: "feat/greet", headSha: "ffffffffffffffff" } as PullRequestDetailView;
const fileDiff = (name: string, type: FileDiffMetadata["type"] = "change") =>
  ({
    name,
    type,
    hunks: [{ additionStart: 3, additionCount: 4, deletionStart: 3, deletionCount: 2 }],
  }) as unknown as FileDiffMetadata;
const symbol = (id: string, name: string, path: string, startLine: number): ProjectCodeSymbol => ({
  id,
  name,
  qualifiedName: name,
  kind: "function",
  language: "typescript",
  path,
  startLine,
  endLine: startLine + 2,
  startColumn: 0,
  endColumn: 1,
  signature: null,
  isExported: true,
});
const greet = symbol("greet", "greet", "src/defs.ts", 4);
const caller = symbol("caller", "caller", "src/use.ts", 10);
const spec = symbol("spec", "checksGreet", "src/defs.test.ts", 2);
const result = (overrides: Partial<ProjectCodeQueryResult>): ProjectCodeQueryResult => ({
  operation: "affected",
  checkoutPath: "/worktrees/greet",
  matches: [],
  nodes: [],
  edges: [],
  files: [],
  unresolvedReferences: [],
  selection: { state: "not-required", candidates: [] },
  sourceDigests: [],
  stats: null,
  coverage: {
    state: "partial",
    catalogRevision: "test",
    relationSemantics: "static-candidates",
    columnEncoding: "utf16-code-units",
    languages: ["typescript"],
    filesListed: 4,
    filesIndexed: 3,
    filesSkipped: 1,
    filesUnsupported: 0,
    filesFailed: 0,
    pendingReferences: 0,
    resultLimitReached: false,
    limitations: [],
  },
  ...overrides,
});
const checkout = {
  environmentId,
  id: ThreadId.make("checkout"),
  projectId,
  title: "Review greet",
  branch: "feat/greet",
  worktreePath: "/worktrees/greet",
  archivedAt: null,
};

function setup(shells: unknown[]) {
  state.queries.length = 0;
  state.results.clear();
  state.shells = shells;
  return AtomRegistry.make();
}

const renderPanel = (registry: AtomRegistry.AtomRegistry) =>
  render(
    <RegistryContext.Provider value={registry}>
      <PullRequestImpactPanel
        environmentId={environmentId}
        reference={reference}
        detail={detail}
        fileDiffs={[fileDiff("src/defs.ts"), fileDiff("src/old.ts", "deleted")]}
      />
    </RegistryContext.Provider>,
  );

it("analyzes a changed file only when it is expanded, against the head branch checkout", async () => {
  const registry = setup([{ ...checkout, worktreePath: null, id: "root" }, checkout]);
  state.results.set(
    "freshness",
    Atom.make(
      AsyncResult.success(
        result({
          operation: "freshness",
          index: {
            state: "ready",
            indexedCommit: "aaaaaaaaaaaaaaaa",
            headCommit: "aaaaaaaaaaaaaaaa",
            generation: 2,
            indexedAt: 0,
            changedFiles: 0,
            changedPaths: [],
          },
        }),
      ),
    ),
  );
  state.results.set(
    "affected",
    Atom.make(
      AsyncResult.success(
        result({
          nodes: [greet, caller, spec],
          edges: [
            {
              source: caller.id,
              target: greet.id,
              kind: "calls",
              confidence: null,
              resolvedBy: null,
              provenance: "heuristic",
              evidenceGrade: "heuristic-candidate",
              line: 11,
              column: null,
              referenceName: null,
              candidateTargets: [],
            },
          ],
          symbolGroups: [{ symbol: greet.id, callers: [caller.id], tests: [spec.id] }],
        }),
      ),
    ),
  );
  await using screen = await renderPanel(registry);
  await screen.getByRole("button", { name: "Potentially affected" }).click();
  await expect.element(screen.getByText(/checkout in “Review greet”/)).toBeVisible();
  await expect.element(screen.getByText(/pull request head is fffffff/)).toBeVisible();
  // Listing files costs nothing; only the expanded file is analyzed.
  expect(state.queries).toEqual([]);
  await expect.element(screen.getByRole("button", { name: /src\/old\.ts/ })).toBeDisabled();

  await screen.getByRole("button", { name: /src\/defs\.ts/ }).click();
  await expect.element(screen.getByText("heuristic")).toBeVisible();
  await expect.element(screen.getByText("static reachability")).toBeVisible();
  await expect.element(screen.getByText("src/defs.test.ts:2")).toBeVisible();
  expect(state.queries).toEqual([
    {
      environmentId,
      input: {
        projectId,
        threadId: checkout.id,
        query: {
          operation: "affected",
          filePath: "src/defs.ts",
          lineRanges: [{ start: 3, end: 6 }],
          limit: 20,
        },
      },
    },
  ]);
});

it("says there is nothing to analyze when no thread has the head branch checked out", async () => {
  const registry = setup([{ ...checkout, branch: "main" }]);
  await using screen = await renderPanel(registry);
  await screen.getByRole("button", { name: "Potentially affected" }).click();
  await expect
    .element(screen.getByText(/No thread here has feat\/greet checked out/))
    .toBeVisible();
  expect(state.queries).toEqual([]);
});
