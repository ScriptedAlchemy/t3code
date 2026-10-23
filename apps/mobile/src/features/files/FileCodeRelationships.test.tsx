import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ProjectCodeQueryInput,
  type ProjectCodeQueryResult,
  type ProjectCodeSymbol,
} from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  queries: [] as ProjectCodeQueryInput[],
  results: new Map<string, unknown>(),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => ({ environment: { capabilities: { projectCode: true } } }),
  },
}));
vi.mock("../../state/projectCode", () => ({
  projectCode: {
    query: Object.assign(
      ({ input }: { input: ProjectCodeQueryInput }) => {
        state.queries.push(input);
        return state.results.get(input.query.operation) ?? null;
      },
      { permissionAtom: () => true },
    ),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (data: unknown) => ({ data, error: null, refresh: () => {} }),
}));

import { FileCodeRelationships } from "./FileCodeRelationships";

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
const spec = symbol("spec", "greets", "src/defs.test.ts", 3);
const result = (overrides: Partial<ProjectCodeQueryResult>): ProjectCodeQueryResult => ({
  operation: "symbols",
  checkoutPath: "/repo",
  matches: [],
  nodes: [],
  edges: [],
  files: [],
  unresolvedReferences: [],
  selection: { state: "matched", candidates: [greet] },
  sourceDigests: [],
  stats: null,
  coverage: {
    state: "stale",
    catalogRevision: "test",
    relationSemantics: "static-candidates",
    columnEncoding: "utf16-code-units",
    languages: [],
    filesListed: 3,
    filesIndexed: 3,
    filesSkipped: 0,
    filesUnsupported: 0,
    filesFailed: 0,
    pendingReferences: 0,
    resultLimitReached: false,
    limitations: [],
  },
  ...overrides,
});
const edge = (source: string, line: number) => ({
  source,
  target: greet.id,
  kind: "calls",
  confidence: null,
  resolvedBy: null,
  provenance: null,
  evidenceGrade: "static-candidate" as const,
  line,
  column: null,
  referenceName: null,
  candidateTargets: [],
});

function setup() {
  state.queries.length = 0;
  state.results.clear();
  state.results.set("symbols", result({ nodes: [greet] }));
  state.results.set("callers", result({ nodes: [greet, caller], edges: [edge(caller.id, 12)] }));
  state.results.set(
    "impact",
    result({ nodes: [greet, caller, spec], edges: [edge(caller.id, 12), edge(spec.id, 5)] }),
  );
  const opened: Array<[string, number]> = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <FileCodeRelationships
        environmentId={EnvironmentId.make("mobile-code")}
        projectId={ProjectId.make("project")}
        threadId={ThreadId.make("thread")}
        relativePath="src/defs.ts"
        onOpenLocation={(path, line) => opened.push([path, line])}
      />,
    ),
  );
  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.startsWith(text),
    );
    expect(found, text).toBeDefined();
    return found!;
  };
  return {
    container,
    opened,
    press: async (text: string) => act(async () => button(text).click()),
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

it("queries the code index only after the section is opened", async () => {
  using screen = setup();
  expect(state.queries).toEqual([]);
  await screen.press("Code relationships");
  expect(state.queries).toEqual([
    {
      projectId: "project",
      threadId: "thread",
      query: { operation: "symbols", filePath: "src/defs.ts", limit: 30 },
    },
  ]);
  expect(screen.container.textContent).toContain("Stale · some files changed since indexing");
});

it("lists callers at their call site and impact with likely tests first", async () => {
  using screen = setup();
  await screen.press("Code relationships");
  await screen.press("greet");
  expect(screen.container.textContent).toContain("src/use.ts:12 · static candidate");
  await screen.press("caller");
  expect(screen.opened).toEqual([["src/use.ts", 12]]);

  await screen.press("Impact");
  const rows = [...screen.container.querySelectorAll("button")]
    .map((item) => item.textContent ?? "")
    .filter((text) => text.startsWith("test") || text.startsWith("file"));
  expect(rows).toEqual(["testsrc/defs.test.ts", "filesrc/use.ts"]);
});
