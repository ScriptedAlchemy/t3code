import "../../index.css";
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ProjectCodeCoverage,
  type ProjectCodeQueryInput,
  type ProjectCodeQueryResult,
  type ProjectCodeSymbol,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  queries: [] as Array<{ environmentId: string; input: unknown }>,
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
      },
    }) as never,
);
vi.mock(
  import("../../state/entities"),
  () =>
    ({
      useQuietThreadShell: () => ({ id: "thread", projectId: "project" }),
    }) as never,
);

import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { FileCodeRelationships } from "./FileCodeRelationships";

const threadRef = {
  environmentId: EnvironmentId.make("code-browser"),
  threadId: ThreadId.make("thread"),
};
const coverage = (state: ProjectCodeCoverage["state"]): ProjectCodeCoverage => ({
  state,
  catalogRevision: "test",
  relationSemantics: "static-candidates",
  columnEncoding: "utf16-code-units",
  languages: ["typescript"],
  filesListed: 12,
  filesIndexed: 10,
  filesSkipped: 2,
  filesUnsupported: 0,
  filesFailed: 0,
  pendingReferences: 0,
  resultLimitReached: false,
  limitations: ["Relations are static candidates."],
});
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
const result = (
  operation: ProjectCodeQueryResult["operation"],
  overrides: Partial<ProjectCodeQueryResult>,
): ProjectCodeQueryResult => ({
  operation,
  checkoutPath: "/repo",
  matches: [],
  nodes: [],
  edges: [],
  files: [],
  unresolvedReferences: [],
  selection: { state: "not-required", candidates: [] },
  sourceDigests: [],
  stats: null,
  coverage: coverage("complete"),
  ...overrides,
});
const greet = symbol("greet", "greet", "src/defs.ts", 4);
const caller = symbol("caller", "caller", "src/use.ts", 10);
const spec = symbol("spec", "greets", "src/defs.test.ts", 3);
const edge = (source: string, line: number | null) => ({
  source,
  target: greet.id,
  kind: "calls",
  confidence: null,
  resolvedBy: "import",
  provenance: null,
  evidenceGrade: "static-candidate" as const,
  line,
  column: null,
  referenceName: null,
  candidateTargets: [],
});

function setup(outline: ProjectCodeQueryResult) {
  state.queries.length = 0;
  state.results.clear();
  state.results.set("symbols", Atom.make(AsyncResult.success(outline)));
  state.results.set(
    "callers",
    Atom.make(
      AsyncResult.success(
        result("callers", {
          nodes: [greet, caller],
          edges: [edge(caller.id, 12)],
          selection: { state: "matched", candidates: [greet] },
        }),
      ),
    ),
  );
  state.results.set(
    "impact",
    Atom.make(
      AsyncResult.success(
        result("impact", {
          nodes: [greet, caller, spec],
          edges: [edge(caller.id, 12), edge(spec.id, 5)],
          selection: { state: "matched", candidates: [greet] },
        }),
      ),
    ),
  );
  useRightPanelStore.setState({ byThreadKey: {} });
  return AtomRegistry.make();
}

const activeSurface = () =>
  selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef);

it("queries only on demand, labels stale static evidence, and opens results at their line", async () => {
  const registry = setup(result("symbols", { nodes: [greet], coverage: coverage("stale") }));
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <FileCodeRelationships
        environmentId={threadRef.environmentId}
        threadRef={threadRef}
        relativePath="src/defs.ts"
      />
    </RegistryContext.Provider>,
  );
  const header = screen.getByRole("button", { name: "Code relationships" });
  await expect.element(header).toBeVisible();
  expect(state.queries).toEqual([]);

  await header.click();
  await expect.element(screen.getByText(/Stale · some returned files changed/)).toBeVisible();
  expect(state.queries[0]).toEqual({
    environmentId: threadRef.environmentId,
    input: {
      projectId: ProjectId.make("project"),
      threadId: threadRef.threadId,
      query: { operation: "symbols", filePath: "src/defs.ts", limit: 50 },
    },
  });

  await screen.getByRole("button", { name: /greet/ }).click();
  expect(activeSurface()).toMatchObject({ relativePath: "src/defs.ts", revealLine: 4 });

  // A caller opens at the call site, not the caller's declaration.
  await screen.getByRole("button", { name: /src\/use\.ts:12/ }).click();
  expect(activeSurface()).toMatchObject({ relativePath: "src/use.ts", revealLine: 12 });

  await screen.getByRole("button", { name: "Impact" }).click();
  const rows = screen.getByRole("button", { name: /symbol · static candidate/ });
  // Likely affected tests sort first.
  await expect.element(rows.nth(1)).toBeVisible();
  expect(rows.elements().map((row) => row.textContent)).toEqual([
    "testsrc/defs.test.ts1 symbol · static candidate",
    "filesrc/use.ts1 symbol · static candidate",
  ]);
  await rows.first().click();
  expect(activeSurface()).toMatchObject({ relativePath: "src/defs.test.ts", revealLine: 3 });
});

it("says when a file has no indexed declarations instead of implying it has none", async () => {
  const registry = setup(result("symbols", { coverage: coverage("partial") }));
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <FileCodeRelationships
        environmentId={threadRef.environmentId}
        threadRef={threadRef}
        relativePath="README.weird"
      />
    </RegistryContext.Provider>,
  );
  await screen.getByRole("button", { name: "Code relationships" }).click();
  await expect.element(screen.getByText(/partial coverage, 10 of 12 files indexed/)).toBeVisible();
  await expect.element(screen.getByText(/language may be unsupported/)).toBeVisible();
});
