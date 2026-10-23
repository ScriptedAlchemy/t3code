import type {
  ProjectCodeEdge,
  ProjectCodeQueryResult,
  ProjectCodeSymbol,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { NODE_CAP, buildExplorerModel, layoutExplorer } from "./codeExplorerModel";

const symbol = (id: string, line = 1): ProjectCodeSymbol => ({
  id,
  name: id,
  qualifiedName: id,
  kind: "function",
  language: "typescript",
  path: `src/${id}.ts`,
  startLine: line,
  endLine: line + 2,
  startColumn: 0,
  endColumn: 1,
  signature: null,
  isExported: true,
});
const edge = (
  source: string,
  target: string,
  evidenceGrade: ProjectCodeEdge["evidenceGrade"] = "static-candidate",
  line: number | null = null,
): ProjectCodeEdge => ({
  source,
  target,
  kind: "calls",
  confidence: null,
  resolvedBy: null,
  provenance: null,
  evidenceGrade,
  line,
  column: null,
  referenceName: null,
  candidateTargets: [],
});
const result = (
  operation: "callers" | "callees",
  nodes: ReadonlyArray<ProjectCodeSymbol>,
  edges: ReadonlyArray<ProjectCodeEdge>,
): ProjectCodeQueryResult => ({
  operation,
  checkoutPath: "/repo",
  matches: [],
  nodes: [...nodes],
  edges: [...edges],
  files: [],
  unresolvedReferences: [],
  selection: { state: "matched", candidates: [nodes[0]!] },
  sourceDigests: [],
  stats: null,
  coverage: {
    state: "complete",
    catalogRevision: "test",
    relationSemantics: "static-candidates",
    columnEncoding: "utf16-code-units",
    languages: [],
    filesListed: 1,
    filesIndexed: 1,
    filesSkipped: 0,
    filesUnsupported: 0,
    filesFailed: 0,
    pendingReferences: 0,
    resultLimitReached: false,
    limitations: [],
  },
});

const focus = symbol("focus");

describe("buildExplorerModel", () => {
  it("places a caller at its shortest hop even when the deep walk found the long route first", () => {
    const a = symbol("a");
    const b = symbol("b");
    // Depth 2 reported `b` only through `a`; depth 1 knows `b` calls the focus directly.
    const deep = result("callers", [focus, a, b], [edge("a", "focus"), edge("b", "a")]);
    const near = result("callers", [focus, a, b], [edge("a", "focus"), edge("b", "focus")]);
    const model = buildExplorerModel({
      focus,
      hops: 2,
      callers: [near, deep],
      callees: [result("callees", [focus], [])],
    });
    expect(model.callers.map((node) => [node.symbol.id, node.hop])).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
  });

  it("folds call sites into one connector at the strongest grade", () => {
    const a = symbol("a");
    const callers = result(
      "callers",
      [focus, a],
      [edge("a", "focus", "heuristic-candidate", 3), edge("a", "focus", "compiler-indexed", 7)],
    );
    const model = buildExplorerModel({
      focus,
      hops: 1,
      callers: [callers],
      callees: [result("callees", [focus], [])],
    });
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]).toMatchObject({ grade: "compiler-indexed", sites: 2, line: 3 });
  });

  it("draws hop 2 only when expanded and counts what the cap leaves out", () => {
    const direct = Array.from({ length: 20 }, (_, index) => symbol(`c${index}`));
    const far = Array.from({ length: 20 }, (_, index) => symbol(`d${index}`));
    const callees = result(
      "callees",
      [focus, ...direct, ...far],
      [
        ...direct.map((node) => edge("focus", node.id)),
        ...far.map((node, index) => edge(direct[index]!.id, node.id)),
      ],
    );
    const callerSymbols = Array.from({ length: 40 }, (_, index) => symbol(`r${index}`));
    const callers = result(
      "callers",
      [focus, ...callerSymbols],
      callerSymbols.map((node) => edge(node.id, "focus")),
    );

    const oneHop = buildExplorerModel({ focus, hops: 1, callers: [callers], callees: [callees] });
    expect(oneHop.callees.every((node) => node.hop === 1)).toBe(true);
    expect(oneHop.callees).toHaveLength(20);

    const twoHops = buildExplorerModel({ focus, hops: 2, callers: [callers], callees: [callees] });
    expect(twoHops.callers.length + twoHops.callees.length).toBe(NODE_CAP);
    // Hop 1 fills a side before hop 2.
    expect(twoHops.callees.slice(0, 20).every((node) => node.hop === 1)).toBe(true);
    expect(twoHops.omitted).toBe(40 + 40 - NODE_CAP);
  });

  it("draws a symbol on both sides once, as a caller", () => {
    const loop = symbol("loop");
    const model = buildExplorerModel({
      focus,
      hops: 1,
      callers: [result("callers", [focus, loop], [edge("loop", "focus")])],
      callees: [result("callees", [focus, loop], [edge("focus", "loop")])],
    });
    expect(model.callers.map((node) => node.symbol.id)).toEqual(["loop"]);
    expect(model.callees).toEqual([]);
  });
});

describe("layoutExplorer", () => {
  it("puts callers left of the focus and callees right of it", () => {
    const a = symbol("a");
    const b = symbol("b");
    const model = buildExplorerModel({
      focus,
      hops: 1,
      callers: [result("callers", [focus, a], [edge("a", "focus")])],
      callees: [result("callees", [focus, b], [edge("focus", "b")])],
    });
    const x = new Map(
      layoutExplorer(model).nodes.map((placed) => [placed.node.symbol.id, placed.x]),
    );
    expect(x.get("a")!).toBeLessThan(x.get("focus")!);
    expect(x.get("focus")!).toBeLessThan(x.get("b")!);
  });
});
