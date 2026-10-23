// @effect-diagnostics nodeBuiltinImport:off - this isolated worker uses synchronous Node APIs for bounded file hashing and SDK path handling.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CodeGraph as CodeGraphInstance,
  Edge,
  IndexProgress,
  Language,
  Node as CodeGraphNode,
  SearchResult,
  UnresolvedReference,
} from "@colbymchenry/codegraph";
import type {
  ProjectCodeCoverage,
  ProjectCodeEdge,
  ProjectCodeFile,
  ProjectCodeMatch,
  ProjectCodeQuery,
  ProjectCodeQueryResult,
  ProjectCodeSelection,
  ProjectCodeSourceDigest,
  ProjectCodeStats,
  ProjectCodeSymbol,
  ProjectCodeUnresolvedReference,
} from "@t3tools/contracts";

const INDEX_DIRECTORY = ".codegraph-t3";
const CATALOG_REVISION = "@colbymchenry/codegraph@1.6.2";
const MAX_RESULTS = 200;
const MAX_FILES_FOR_UNRESOLVED = 50;
const MAX_LISTED_FILES = 10_000;

interface CodeGraphModule {
  readonly CodeGraph: {
    isInitialized(root: string): boolean;
    init(root: string, options: { index: false }): Promise<CodeGraphInstance>;
    open(root: string, options: { sync: false }): Promise<CodeGraphInstance>;
    recreate(root: string): Promise<CodeGraphInstance>;
  };
  readonly getSupportedLanguages: () => Language[];
  readonly detectLanguage: (path: string) => Language;
}

export interface CodeIntelligenceWorkerInput {
  readonly checkoutPath: string;
  readonly files: ReadonlyArray<string>;
  readonly filesListed: number;
  readonly listingTruncated: boolean;
  readonly query: ProjectCodeQuery;
}

function sdk(): CodeGraphModule {
  return NodeModule.createRequire(import.meta.url)("@colbymchenry/codegraph") as CodeGraphModule;
}

function mapSymbol(node: CodeGraphNode): ProjectCodeSymbol {
  return {
    id: node.id.slice(0, 2048),
    name: node.name.slice(0, 512),
    qualifiedName: node.qualifiedName.slice(0, 2048),
    kind: node.kind.slice(0, 512),
    language: node.language.slice(0, 512),
    path: node.filePath.slice(0, 2048),
    startLine: node.startLine,
    endLine: node.endLine,
    startColumn: node.startColumn,
    endColumn: node.endColumn,
    signature: node.signature?.slice(0, 2048) ?? null,
    isExported: node.isExported ?? false,
  };
}

function mapEdge(
  edge: Edge,
  graph: CodeGraphInstance,
  allowedPaths: ReadonlySet<string>,
): ProjectCodeEdge {
  const confidence = edge.metadata?.confidence;
  const resolvedBy = edge.metadata?.resolvedBy;
  const referenceName = edge.metadata?.refName;
  const alsoTargets = edge.metadata?.alsoTargets;
  return {
    source: edge.source.slice(0, 2048),
    target: edge.target.slice(0, 2048),
    kind: edge.kind.slice(0, 512),
    confidence: typeof confidence === "number" ? confidence : null,
    resolvedBy: typeof resolvedBy === "string" ? resolvedBy.slice(0, 512) : null,
    provenance: edge.provenance ?? null,
    evidenceGrade:
      edge.provenance === "scip"
        ? "compiler-indexed"
        : edge.provenance === "heuristic"
          ? "heuristic-candidate"
          : "static-candidate",
    line: edge.line ?? null,
    column: edge.column ?? null,
    referenceName: typeof referenceName === "string" ? referenceName.slice(0, 512) : null,
    candidateTargets: Array.isArray(alsoTargets)
      ? alsoTargets
          .flatMap((target) => {
            if (typeof target !== "object" || target === null) return [];
            const id = (target as { readonly targetNodeId?: unknown }).targetNodeId;
            if (typeof id !== "string") return [];
            const node = graph.getNode(id);
            return node !== null && allowedPaths.has(node.filePath) ? [id.slice(0, 2048)] : [];
          })
          .slice(0, 20)
      : [],
  };
}

function mapMatch(result: SearchResult): ProjectCodeMatch {
  return {
    symbol: mapSymbol(result.node),
    score: result.score,
    highlights: (result.highlights ?? []).slice(0, 16).map((highlight) => highlight.slice(0, 2048)),
  };
}

function mapUnresolved(
  reference: UnresolvedReference,
  graph: CodeGraphInstance,
  allowedPaths: ReadonlySet<string>,
): ProjectCodeUnresolvedReference {
  return {
    from: reference.fromNodeId.slice(0, 2048),
    name: reference.referenceName.slice(0, 512),
    kind: reference.referenceKind.slice(0, 512),
    filePath: (reference.filePath ?? "").slice(0, 2048),
    language: reference.language?.slice(0, 512) ?? null,
    line: reference.line,
    column: reference.column,
    candidates: (reference.candidates ?? [])
      .filter((candidate) => {
        const node = graph.getNode(candidate);
        return node !== null && allowedPaths.has(node.filePath);
      })
      .slice(0, 20)
      .map((candidate) => candidate.slice(0, 2048)),
  };
}

function safeRelativePath(checkoutPath: string, filePath: string): string | null {
  const resolved = NodePath.resolve(checkoutPath, filePath);
  const relative = NodePath.relative(checkoutPath, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  )
    return null;
  return relative.split(NodePath.sep).join("/");
}

function authorizedSourcePath(checkoutPath: string, filePath: string): string | null {
  const relativePath = safeRelativePath(checkoutPath, filePath);
  if (relativePath === null) return null;
  try {
    const root = NodeFS.realpathSync(checkoutPath);
    const source = NodeFS.realpathSync(NodePath.resolve(root, relativePath));
    const relative = NodePath.relative(root, source);
    return relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
      ? null
      : relativePath;
  } catch {
    return null;
  }
}

function validateIndexDirectory(checkoutPath: string): void {
  const indexPath = NodePath.join(checkoutPath, INDEX_DIRECTORY);
  try {
    if (NodeFS.lstatSync(indexPath).isSymbolicLink()) throw new Error("index-outside-checkout");
    const root = NodeFS.realpathSync(checkoutPath);
    const index = NodeFS.realpathSync(indexPath);
    const relative = NodePath.relative(root, index);
    if (
      relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    ) {
      throw new Error("index-outside-checkout");
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message === "index-outside-checkout") throw cause;
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}

function selectSymbols(
  graph: CodeGraphInstance,
  input: Extract<
    ProjectCodeQuery,
    { readonly operation: "callers" | "callees" | "references" | "impact" }
  >["symbol"],
  limit: number,
  allowedPaths: ReadonlySet<string>,
): ProjectCodeSymbol[] {
  return graph
    .getNodesByName(input.name)
    .filter((node) => allowedPaths.has(node.filePath))
    .filter((node) => input.filePath === undefined || node.filePath === input.filePath)
    .filter(
      (node) =>
        input.line === undefined || (node.startLine <= input.line && input.line <= node.endLine),
    )
    .slice(0, limit + 1)
    .map(mapSymbol);
}

function exactDigest(
  checkoutPath: string,
  graph: CodeGraphInstance,
  relativePath: string,
): ProjectCodeSourceDigest {
  const normalizedPath = safeRelativePath(checkoutPath, relativePath);
  if (normalizedPath === null) return { path: relativePath, digest: "", verified: false };
  try {
    const absolutePath = NodePath.resolve(checkoutPath, normalizedPath);
    const realCheckout = NodeFS.realpathSync(checkoutPath);
    const realSource = NodeFS.realpathSync(absolutePath);
    const realRelative = NodePath.relative(realCheckout, realSource);
    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(realRelative)
    ) {
      return { path: normalizedPath, digest: "", verified: false };
    }
    const descriptor = NodeFS.openSync(realSource, "r");
    let digest: string;
    let stableRead: boolean;
    let validUtf8 = true;
    try {
      const before = NodeFS.fstatSync(descriptor);
      const bytes = NodeFS.readFileSync(descriptor);
      const after = NodeFS.fstatSync(descriptor);
      stableRead =
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        NodeFS.realpathSync(absolutePath) === realSource;
      digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        validUtf8 = false;
      }
    } finally {
      NodeFS.closeSync(descriptor);
    }
    const indexed = graph.getFile(normalizedPath);
    return {
      path: normalizedPath,
      digest,
      verified: stableRead && validUtf8 && indexed?.contentHash === digest,
    };
  } catch {
    return { path: normalizedPath, digest: "", verified: false };
  }
}

export async function inspectCodeInWorker(
  input: CodeIntelligenceWorkerInput,
  signal: AbortSignal,
  onProgress: (progress: Pick<IndexProgress, "phase" | "current" | "total">) => void,
): Promise<ProjectCodeQueryResult> {
  const { CodeGraph, detectLanguage, getSupportedLanguages } = sdk();
  validateIndexDirectory(input.checkoutPath);
  const listedPaths = input.files.slice(0, MAX_LISTED_FILES).flatMap((path) => {
    const authorized = authorizedSourcePath(input.checkoutPath, path);
    return authorized === null ? [] : [authorized];
  });
  const listedPathSet = new Set(listedPaths);
  const queryPath =
    input.query.operation === "dependencies"
      ? input.query.filePath
      : input.query.operation === "symbols"
        ? input.query.filePath
        : input.query.operation === "callers" ||
            input.query.operation === "callees" ||
            input.query.operation === "references" ||
            input.query.operation === "impact"
          ? input.query.symbol.filePath
          : undefined;
  if (
    queryPath !== undefined &&
    safeRelativePath(input.checkoutPath, queryPath) !== null &&
    authorizedSourcePath(input.checkoutPath, queryPath) === null
  ) {
    throw new Error("path-outside-checkout");
  }
  let graph = CodeGraph.isInitialized(input.checkoutPath)
    ? await CodeGraph.open(input.checkoutPath, { sync: false })
    : await CodeGraph.init(input.checkoutPath, { index: false });
  try {
    const stalePaths = graph
      .getFiles()
      .filter(
        (file) =>
          authorizedSourcePath(input.checkoutPath, file.path) === null &&
          NodeFS.existsSync(NodePath.resolve(input.checkoutPath, file.path)),
      );
    if (stalePaths.length > 0) {
      graph.close();
      graph = await CodeGraph.recreate(input.checkoutPath);
    }
    const reconcilePaths = new Set(listedPaths);
    for (const file of graph.getFiles()) {
      if (reconcilePaths.size >= MAX_LISTED_FILES * 2) break;
      const authorized = authorizedSourcePath(input.checkoutPath, file.path);
      if (authorized !== null) reconcilePaths.add(authorized);
      else if (!NodeFS.existsSync(NodePath.resolve(input.checkoutPath, file.path)))
        reconcilePaths.add(file.path);
    }
    await graph.sync({ signal, onProgress, paths: [...reconcilePaths] });
    const languageCatalog = getSupportedLanguages();
    const supportedLanguages = new Set(languageCatalog);
    const filesUnsupported = listedPaths.filter((path) => {
      const language = detectLanguage(path);
      return language === "unknown" || !supportedLanguages.has(language);
    }).length;
    const files = graph.getFiles().filter((file) => listedPathSet.has(file.path));
    const filesFailed = files.filter((file) => (file.errors?.length ?? 0) > 0).length;
    const indexedPaths = new Set(files.map((file) => file.path));
    const filesSkipped =
      input.files.slice(0, MAX_LISTED_FILES).length -
      listedPaths.length +
      listedPaths.filter(
        (path) => supportedLanguages.has(detectLanguage(path)) && !indexedPaths.has(path),
      ).length;
    const stats = graph.getStats();
    const limit = Math.min(
      input.query.operation === "status" ? MAX_RESULTS : (input.query.limit ?? 100),
      MAX_RESULTS,
    );
    const matches: ProjectCodeMatch[] = [];
    const nodes = new Map<string, ProjectCodeSymbol>();
    const edges = new Map<string, ProjectCodeEdge>();
    const relatedFiles = new Set<string>();
    const unresolvedReferences: ProjectCodeUnresolvedReference[] = [];
    let selection: ProjectCodeSelection = { state: "not-required", candidates: [] };
    let resultLimitReached = false;

    const addNode = (node: CodeGraphNode) => {
      if (!listedPathSet.has(node.filePath)) return;
      if (nodes.size >= limit && !nodes.has(node.id)) {
        resultLimitReached = true;
        return;
      }
      const symbol = mapSymbol(node);
      nodes.set(node.id, symbol);
      relatedFiles.add(symbol.path);
    };
    const addEdge = (edge: Edge) => {
      const source = graph.getNode(edge.source);
      const target = graph.getNode(edge.target);
      if (
        source === null ||
        target === null ||
        !listedPathSet.has(source.filePath) ||
        !listedPathSet.has(target.filePath)
      )
        return;
      const id = `${edge.source}\0${edge.target}\0${edge.kind}\0${edge.line ?? ""}\0${edge.column ?? ""}`;
      if (edges.size >= limit && !edges.has(id)) {
        resultLimitReached = true;
        return;
      }
      edges.set(id, mapEdge(edge, graph, listedPathSet));
    };
    const addPair = (pair: { readonly node: CodeGraphNode; readonly edge: Edge }) => {
      addNode(pair.node);
      addEdge(pair.edge);
    };

    switch (input.query.operation) {
      case "search": {
        const results = graph
          .searchNodes(input.query.text, { limit: MAX_RESULTS })
          .filter((result) => listedPathSet.has(result.node.filePath))
          .slice(0, limit + 1);
        if (results.length >= limit) resultLimitReached = true;
        for (const result of results) {
          if (matches.length >= limit) {
            resultLimitReached = true;
            break;
          }
          const match = mapMatch(result);
          matches.push(match);
          addNode(result.node);
        }
        break;
      }
      case "symbols": {
        const query = input.query;
        for (const node of graph
          .getNodesByName(query.name)
          .filter((candidate) => listedPathSet.has(candidate.filePath))
          .filter(
            (candidate) => query.filePath === undefined || candidate.filePath === query.filePath,
          )
          .slice(0, limit + 1)) {
          if (nodes.size >= limit) {
            resultLimitReached = true;
            break;
          }
          addNode(node);
        }
        break;
      }
      case "callers":
      case "callees":
      case "references":
      case "impact": {
        const candidates = selectSymbols(graph, input.query.symbol, limit, listedPathSet);
        if (candidates.length === 0) {
          selection = { state: "not-found", candidates: [] };
          break;
        }
        if (candidates.length !== 1) {
          selection = { state: "ambiguous", candidates: candidates.slice(0, limit) };
          resultLimitReached = candidates.length > limit;
          candidates.slice(0, limit).forEach((candidate) => relatedFiles.add(candidate.path));
          break;
        }
        selection = { state: "matched", candidates };
        const selected = candidates[0]!;
        const selectedNode = graph.getNode(selected.id);
        if (selectedNode === null || !listedPathSet.has(selectedNode.filePath)) {
          selection = { state: "not-found", candidates: [] };
          break;
        }
        addNode(selectedNode);
        if (input.query.operation === "callers") {
          const results = graph.getCallers(selected.id, input.query.depth ?? 1);
          results.slice(0, limit + 1).forEach(addPair);
          if (results.length > limit) resultLimitReached = true;
        } else if (input.query.operation === "callees") {
          const results = graph.getCallees(selected.id, input.query.depth ?? 1);
          results.slice(0, limit + 1).forEach(addPair);
          if (results.length > limit) resultLimitReached = true;
        } else if (input.query.operation === "references") {
          const results = graph.findUsages(selected.id);
          results.slice(0, limit + 1).forEach(addPair);
          if (results.length > limit) resultLimitReached = true;
        } else {
          const subgraph = graph.getImpactRadius(selected.id, input.query.depth ?? 3);
          const subgraphNodes = [...subgraph.nodes.values()];
          const subgraphEdges = [...subgraph.edges.values()];
          subgraphNodes.slice(0, limit + 1).forEach(addNode);
          subgraphEdges.slice(0, limit + 1).forEach(addEdge);
          if (subgraphNodes.length > limit || subgraphEdges.length > limit)
            resultLimitReached = true;
        }
        for (const unresolved of graph.getUnresolvedReferencesInFile(selected.path, limit)) {
          const source = graph.getNode(unresolved.fromNodeId);
          if (source === null || !listedPathSet.has(source.filePath)) continue;
          if (unresolvedReferences.length >= limit) {
            resultLimitReached = true;
            break;
          }
          unresolvedReferences.push(mapUnresolved(unresolved, graph, listedPathSet));
        }
        break;
      }
      case "dependencies": {
        const path = safeRelativePath(input.checkoutPath, input.query.filePath);
        if (path === null || !listedPathSet.has(path)) break;
        const related =
          input.query.direction === "imports"
            ? graph.getFileDependencies(path)
            : graph.getFileDependents(path);
        relatedFiles.add(path);
        const authorizedRelated = related.filter((relatedPath) => listedPathSet.has(relatedPath));
        for (const relatedPath of authorizedRelated.slice(0, limit)) {
          relatedFiles.add(relatedPath);
          graph.getNodesInFile(relatedPath).forEach(addNode);
        }
        if (authorizedRelated.length > limit) resultLimitReached = true;
        break;
      }
      case "status":
        break;
    }

    const sourceDigests = [...relatedFiles]
      .slice(0, MAX_FILES_FOR_UNRESOLVED)
      .map((path) => exactDigest(input.checkoutPath, graph, path));
    if (relatedFiles.size > sourceDigests.length) resultLimitReached = true;
    const limitations: string[] = [];
    limitations.push(
      "Relations are static candidates. Import/name resolution can misresolve shadowed names, and SDK confidence is a heuristic score rather than certainty.",
    );
    let coverageIncomplete = false;
    if (input.listingTruncated || input.files.length > MAX_LISTED_FILES) {
      coverageIncomplete = true;
      limitations.push("Workspace file listing is truncated.");
    }
    if (filesUnsupported > 0) {
      coverageIncomplete = true;
      limitations.push(
        `${filesUnsupported} listed files use languages outside the SDK runtime catalog.`,
      );
    }
    if (filesSkipped > 0) {
      coverageIncomplete = true;
      limitations.push(
        `${filesSkipped} listed source files were outside the checkout or were not indexed.`,
      );
    }
    if (filesFailed > 0) {
      coverageIncomplete = true;
      limitations.push(`${filesFailed} indexed files report extraction errors.`);
    }
    if (graph.getPendingReferenceCount() > 0) {
      coverageIncomplete = true;
      limitations.push(
        "The graph index has unresolved pending references from an interrupted resolution pass.",
      );
    }
    if (sourceDigests.some((source) => !source.verified)) {
      coverageIncomplete = true;
      limitations.push(
        "One or more returned source files are invalid UTF-8 or no longer match the graph index.",
      );
    }
    if (resultLimitReached) {
      coverageIncomplete = true;
      limitations.push(`Query results were limited to ${limit} rows per section.`);
    }
    const digestMismatch = sourceDigests.some((source) => !source.verified);
    const coverage: ProjectCodeCoverage = {
      state: digestMismatch ? "stale" : coverageIncomplete ? "partial" : "complete",
      catalogRevision: CATALOG_REVISION,
      relationSemantics: "static-candidates",
      columnEncoding: "utf16-code-units",
      languages: [...languageCatalog],
      filesListed: input.filesListed,
      filesIndexed: files.length,
      filesSkipped,
      filesUnsupported,
      filesFailed,
      pendingReferences: graph.getPendingReferenceCount(),
      resultLimitReached,
      limitations,
    };
    const outputStats: ProjectCodeStats = {
      nodes: stats.nodeCount,
      edges: stats.edgeCount,
      files: files.length,
      lastUpdated: stats.lastUpdated,
    };
    return {
      operation: input.query.operation,
      checkoutPath: input.checkoutPath,
      matches,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      files: [...relatedFiles].slice(0, limit).map((path): ProjectCodeFile => ({ path })),
      unresolvedReferences,
      selection,
      sourceDigests,
      stats: input.query.operation === "status" ? outputStats : null,
      coverage,
    };
  } finally {
    graph.close();
  }
}
