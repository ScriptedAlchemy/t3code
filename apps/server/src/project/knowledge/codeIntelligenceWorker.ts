// @effect-diagnostics nodeBuiltinImport:off globalDate:off - this isolated worker runs outside the Effect runtime and uses synchronous Node APIs for bounded file hashing and SDK path handling.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import type {
  CodeGraph as CodeGraphInstance,
  Edge,
  IndexProgress,
  Language,
  Node as CodeGraphNode,
  SearchResult,
  UnresolvedReference,
} from "@colbymchenry/codegraph";
import { isLikelyTestPath } from "@t3tools/shared/testPaths";
import type {
  ProjectCodeCoverage,
  ProjectCodeEdge,
  ProjectCodeFile,
  ProjectCodeIndexInfo,
  ProjectCodeSymbolGroup,
  ProjectCodeMatch,
  ProjectCodePathSearch,
  ProjectCodeQuery,
  ProjectCodeQueryResult,
  ProjectCodeSelection,
  ProjectCodeSourceDigest,
  ProjectCodeStats,
  ProjectCodeSymbol,
  ProjectCodeSymbolSelector,
  ProjectCodeUnresolvedReference,
} from "@t3tools/contracts";

const INDEX_DIRECTORY = ".codegraph-t3";
const CATALOG_REVISION = "@colbymchenry/codegraph@1.6.2";
const MAX_RESULTS = 200;
const MAX_FILES_FOR_UNRESOLVED = 50;
const MAX_LISTED_FILES = 10_000;
const INDEX_META_FILE = "t3-index.json";
// A test or path walk stops after this many visited symbols, whatever the depth.
const MAX_WALK_NODES = 2_000;
const DEFAULT_PATH_DEPTH = 6;
const MAX_AFFECTED_SYMBOLS = 20;
const AFFECTED_CALLERS_PER_SYMBOL = 8;
const AFFECTED_TESTS_PER_SYMBOL = 5;

interface CodeGraphModule {
  readonly CodeGraph: {
    isInitialized(root: string): boolean;
    init(root: string, options: { index: false }): Promise<CodeGraphInstance>;
    open(root: string, options: { sync: false; readOnly?: boolean }): Promise<CodeGraphInstance>;
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
    // The SDK opens the database, its -wal/-shm sidecars, its lock and .gitignore by path, and
    // follows a link or shared inode out of the checkout; anything but a plain entry is refused.
    for (const name of NodeFS.readdirSync(indexPath)) {
      const child = NodeFS.lstatSync(NodePath.join(indexPath, name));
      if (!(child.isDirectory() || (child.isFile() && child.nlink === 1))) {
        throw new Error("index-outside-checkout");
      }
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message === "index-outside-checkout") throw cause;
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}

interface IndexMeta {
  readonly commit: string | null;
  readonly generation: number;
  readonly indexedAt: number | null;
}

function readIndexMeta(checkoutPath: string): IndexMeta {
  try {
    const descriptor = NodeFS.openSync(
      NodePath.join(checkoutPath, INDEX_DIRECTORY, INDEX_META_FILE),
      NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
    );
    let text: string;
    try {
      text = NodeFS.readFileSync(descriptor, "utf8");
    } finally {
      NodeFS.closeSync(descriptor);
    }
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) throw new Error("invalid");
    const { commit, generation, indexedAt } = raw as Record<string, unknown>;
    return {
      commit: typeof commit === "string" && /^[0-9a-f]{7,64}$/.test(commit) ? commit : null,
      generation:
        typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0
          ? generation
          : 0,
      indexedAt: typeof indexedAt === "number" && Number.isFinite(indexedAt) ? indexedAt : null,
    };
  } catch {
    return { commit: null, generation: 0, indexedAt: null };
  }
}

function writeIndexMeta(checkoutPath: string, meta: IndexMeta): void {
  const target = NodePath.join(checkoutPath, INDEX_DIRECTORY, INDEX_META_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    // An exclusive create never follows a planted link, and the rename replaces the entry
    // rather than writing through whatever it pointed at.
    NodeFS.writeFileSync(temporary, JSON.stringify(meta), { flag: "wx" });
    NodeFS.renameSync(temporary, target);
  } catch {
    NodeFS.rmSync(temporary, { force: true });
    // The marker only labels freshness; an unwritable one reads back as an unknown commit.
  }
}

// The worker owns its thread, so a short synchronous git call blocks nothing else.
function headCommit(checkoutPath: string): string | null {
  try {
    const output = NodeChildProcess.execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      {
        cwd: checkoutPath,
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return /^[0-9a-f]{7,64}$/.test(output) ? output : null;
  } catch {
    return null;
  }
}

function sha256File(path: string): string | null {
  try {
    return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Listed source files whose bytes no longer match the index, plus supported files the index
 * has never seen. Size and mtime screen out unchanged files so only candidates are hashed.
 */
function changedSinceIndex(
  checkoutPath: string,
  graph: CodeGraphInstance,
  listedPaths: ReadonlyArray<string>,
  isSupported: (path: string) => boolean,
): string[] {
  const listed = new Set(listedPaths);
  const indexed = new Map(graph.getFiles().map((file) => [file.path, file]));
  const changed: string[] = [];
  for (const path of listedPaths) {
    const record = indexed.get(path);
    const absolute = NodePath.resolve(checkoutPath, path);
    if (record === undefined) {
      if (isSupported(path)) changed.push(path);
      continue;
    }
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.statSync(absolute);
    } catch {
      changed.push(path);
      continue;
    }
    if (stat.size === record.size && Math.trunc(stat.mtimeMs) === Math.trunc(record.modifiedAt))
      continue;
    if (sha256File(absolute) !== record.contentHash) changed.push(path);
  }
  for (const path of indexed.keys()) {
    if (!listed.has(path) && !NodeFS.existsSync(NodePath.resolve(checkoutPath, path)))
      changed.push(path);
  }
  return changed;
}

function selectSymbols(
  graph: CodeGraphInstance,
  input: ProjectCodeSymbolSelector,
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

// A file outline lists declarations; these kinds are structure or noise there.
const FILE_OUTLINE_EXCLUDED_KINDS: ReadonlySet<string> = new Set([
  "file",
  "import",
  "export",
  "parameter",
]);

/**
 * Top-level test code (an `it` callback) is attributed to the file, so a test file node is kept
 * only when the walk found no declaration in that file to name instead.
 */
function preferDeclarations(tests: ReadonlyArray<CodeGraphNode>): CodeGraphNode[] {
  const named = new Set(
    tests
      .filter((test) => !FILE_OUTLINE_EXCLUDED_KINDS.has(test.kind))
      .map((test) => test.filePath),
  );
  return tests.filter(
    (test) => !FILE_OUTLINE_EXCLUDED_KINDS.has(test.kind) || !named.has(test.filePath),
  );
}

export async function inspectCodeInWorker(
  input: CodeIntelligenceWorkerInput,
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
    input.query.operation === "dependencies" ||
    input.query.operation === "symbols" ||
    input.query.operation === "affected"
      ? input.query.filePath
      : input.query.operation === "callers" ||
          input.query.operation === "callees" ||
          input.query.operation === "references" ||
          input.query.operation === "impact" ||
          input.query.operation === "tests"
        ? input.query.symbol.filePath
        : undefined;
  const queryPaths =
    input.query.operation === "path"
      ? [input.query.from.filePath, input.query.to.filePath]
      : [queryPath];
  for (const path of queryPaths) {
    if (
      path !== undefined &&
      safeRelativePath(input.checkoutPath, path) !== null &&
      authorizedSourcePath(input.checkoutPath, path) === null
    ) {
      throw new Error("path-outside-checkout");
    }
  }
  if (input.query.operation === "freshness") {
    return await inspectFreshness(input, listedPaths, sdk());
  }
  const initialized = CodeGraph.isInitialized(input.checkoutPath);
  let graph = initialized
    ? await CodeGraph.open(input.checkoutPath, { sync: false })
    : await CodeGraph.init(input.checkoutPath, { index: false });
  try {
    let recreated = false;
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
      recreated = true;
    }
    const reconcilePaths = new Set(listedPaths);
    for (const file of graph.getFiles()) {
      if (reconcilePaths.size >= MAX_LISTED_FILES * 2) break;
      const authorized = authorizedSourcePath(input.checkoutPath, file.path);
      if (authorized !== null) reconcilePaths.add(authorized);
      else if (!NodeFS.existsSync(NodePath.resolve(input.checkoutPath, file.path)))
        reconcilePaths.add(file.path);
    }
    const synced = await graph.sync({ onProgress, paths: [...reconcilePaths] });
    const priorMeta = readIndexMeta(input.checkoutPath);
    const commit = headCommit(input.checkoutPath);
    const indexChanged =
      !initialized ||
      recreated ||
      synced.filesAdded + synced.filesModified + synced.filesRemoved > 0;
    const meta: IndexMeta = indexChanged
      ? { commit, generation: priorMeta.generation + 1, indexedAt: Date.now() }
      : { ...priorMeta, commit };
    if (indexChanged || priorMeta.commit !== commit) writeIndexMeta(input.checkoutPath, meta);
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
      input.query.operation === "status" || input.query.operation === "path"
        ? MAX_RESULTS
        : (input.query.limit ?? 100),
      MAX_RESULTS,
    );
    const matches: ProjectCodeMatch[] = [];
    const nodes = new Map<string, ProjectCodeSymbol>();
    const edges = new Map<string, ProjectCodeEdge>();
    const relatedFiles = new Set<string>();
    const unresolvedReferences: ProjectCodeUnresolvedReference[] = [];
    let selection: ProjectCodeSelection = { state: "not-required", candidates: [] };
    let resultLimitReached = false;
    const symbolGroups: ProjectCodeSymbolGroup[] = [];
    let pathSearch: ProjectCodePathSearch | null = null;

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

    /**
     * Walks usages outward from `startId`, breadth first, and returns the test-file symbols it
     * reaches with the edges that led to each. Use sites are static candidates, so a reached
     * test is a reachability claim, never a coverage one.
     */
    const reachingTests = (startId: string, depth: number, maxTests: number) => {
      const via = new Map<string, Edge>();
      const visited = new Set([startId]);
      const tests: CodeGraphNode[] = [];
      let frontier = [startId];
      for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const usage of graph.findUsages(id)) {
            if (visited.has(usage.node.id) || !listedPathSet.has(usage.node.filePath)) continue;
            if (visited.size >= MAX_WALK_NODES)
              return { tests: preferDeclarations(tests), via, truncated: true };
            visited.add(usage.node.id);
            via.set(usage.node.id, usage.edge);
            if (isLikelyTestPath(usage.node.filePath)) {
              tests.push(usage.node);
              if (tests.length >= maxTests)
                return { tests: preferDeclarations(tests), via, truncated: true };
            } else next.push(usage.node.id);
          }
        }
        frontier = next;
      }
      return { tests: preferDeclarations(tests), via, truncated: false };
    };
    const addTestChain = (test: CodeGraphNode, startId: string, via: Map<string, Edge>) => {
      let current: CodeGraphNode | null = test;
      while (current !== null && current.id !== startId) {
        addNode(current);
        const edge = via.get(current.id);
        if (edge === undefined) break;
        addEdge(edge);
        current = graph.getNode(edge.target);
      }
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
        const found =
          query.name === undefined
            ? query.filePath === undefined
              ? []
              : graph
                  .getNodesInFile(query.filePath)
                  .filter((candidate) => !FILE_OUTLINE_EXCLUDED_KINDS.has(candidate.kind))
                  .toSorted(
                    (left, right) =>
                      left.startLine - right.startLine || left.startColumn - right.startColumn,
                  )
            : graph.getNodesByName(query.name);
        for (const node of found
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
      case "affected": {
        const query = input.query;
        const path = safeRelativePath(input.checkoutPath, query.filePath);
        if (path === null || !listedPathSet.has(path)) break;
        relatedFiles.add(path);
        const ranges = query.lineRanges;
        const changed = graph
          .getNodesInFile(path)
          .filter((node) => !FILE_OUTLINE_EXCLUDED_KINDS.has(node.kind))
          .filter(
            (node) =>
              ranges === undefined ||
              ranges.some((range) => node.startLine <= range.end && range.start <= node.endLine),
          )
          .toSorted((left, right) => left.startLine - right.startLine);
        const symbolLimit = Math.min(query.limit ?? MAX_AFFECTED_SYMBOLS, MAX_AFFECTED_SYMBOLS);
        if (changed.length > symbolLimit) resultLimitReached = true;
        for (const node of changed.slice(0, symbolLimit)) {
          addNode(node);
          const callers = graph
            .getCallers(node.id, 1)
            .filter((usage) => listedPathSet.has(usage.node.filePath));
          if (callers.length > AFFECTED_CALLERS_PER_SYMBOL) resultLimitReached = true;
          const keptCallers = callers.slice(0, AFFECTED_CALLERS_PER_SYMBOL);
          keptCallers.forEach(addPair);
          const walk = reachingTests(node.id, 3, AFFECTED_TESTS_PER_SYMBOL);
          if (walk.truncated) resultLimitReached = true;
          walk.tests.forEach(addNode);
          symbolGroups.push({
            symbol: node.id.slice(0, 2048),
            callers: keptCallers
              .filter((usage) => nodes.has(usage.node.id))
              .map((usage) => usage.node.id.slice(0, 2048)),
            tests: walk.tests
              .filter((test) => nodes.has(test.id))
              .map((test) => test.id.slice(0, 2048)),
          });
        }
        break;
      }
      case "callers":
      case "callees":
      case "references":
      case "impact":
      case "tests": {
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
        } else if (input.query.operation === "tests") {
          const walk = reachingTests(selected.id, input.query.depth ?? 3, limit);
          if (walk.truncated) resultLimitReached = true;
          for (const test of walk.tests) addTestChain(test, selected.id, walk.via);
          symbolGroups.push({
            symbol: selected.id.slice(0, 2048),
            callers: [],
            tests: walk.tests
              .filter((test) => nodes.has(test.id))
              .map((test) => test.id.slice(0, 2048)),
          });
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
      case "path": {
        const query = input.query;
        const maxDepth = query.depth ?? DEFAULT_PATH_DEPTH;
        const fromCandidates = selectSymbols(graph, query.from, limit, listedPathSet);
        const toCandidates =
          fromCandidates.length === 1 ? selectSymbols(graph, query.to, limit, listedPathSet) : [];
        const unresolvedEndpoint =
          fromCandidates.length !== 1 ? "from" : toCandidates.length !== 1 ? "to" : null;
        if (unresolvedEndpoint !== null) {
          const candidates = unresolvedEndpoint === "from" ? fromCandidates : toCandidates;
          selection = {
            state: candidates.length === 0 ? "not-found" : "ambiguous",
            candidates: candidates.slice(0, limit),
          };
          resultLimitReached = candidates.length > limit;
          pathSearch = {
            found: false,
            maxDepth,
            visitedSymbols: 0,
            walkTruncated: false,
            unresolvedEndpoint,
          };
          break;
        }
        const from = fromCandidates[0]!;
        const targetId = toCandidates[0]!.id;
        selection = { state: "matched", candidates: [from, toCandidates[0]!] };
        // Breadth first over the same outgoing kinds `callees` follows, so the shortest route
        // within the bound is the one returned.
        const via = new Map<string, Edge>();
        const visited = new Set([from.id]);
        let frontier = [from.id];
        let found = from.id === targetId;
        let walkTruncated = false;
        walk: for (let hop = 0; hop < maxDepth && frontier.length > 0 && !found; hop += 1) {
          const next: string[] = [];
          for (const id of frontier) {
            for (const callee of graph.getCallees(id, 1)) {
              if (visited.has(callee.node.id) || !listedPathSet.has(callee.node.filePath)) continue;
              if (visited.size >= MAX_WALK_NODES) {
                walkTruncated = true;
                break walk;
              }
              visited.add(callee.node.id);
              via.set(callee.node.id, callee.edge);
              if (callee.node.id === targetId) {
                found = true;
                break walk;
              }
              next.push(callee.node.id);
            }
          }
          frontier = next;
        }
        if (found) {
          const route: Edge[] = [];
          for (let id = targetId; id !== from.id;) {
            const edge = via.get(id);
            if (edge === undefined) break;
            route.unshift(edge);
            id = edge.source;
          }
          const fromNode = graph.getNode(from.id);
          if (fromNode !== null) addNode(fromNode);
          for (const edge of route) {
            const target = graph.getNode(edge.target);
            if (target !== null) addNode(target);
            addEdge(edge);
          }
        }
        pathSearch = {
          found,
          maxDepth,
          visitedSymbols: visited.size,
          walkTruncated,
          unresolvedEndpoint: null,
        };
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
      indexedLanguages: indexedLanguages(files),
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
      index: {
        state:
          coverage.state === "stale"
            ? "stale"
            : coverage.state === "complete"
              ? "ready"
              : "partial",
        indexedCommit: meta.commit,
        headCommit: commit,
        generation: meta.generation,
        indexedAt: meta.indexedAt,
        changedFiles: 0,
        changedPaths: [],
      },
      ...(symbolGroups.length > 0 ? { symbolGroups } : {}),
      ...(pathSearch !== null ? { pathSearch } : {}),
    };
  } finally {
    graph.close();
  }
}

function indexedLanguages(files: ReadonlyArray<{ readonly language: string }>): string[] {
  return [...new Set(files.map((file) => file.language))]
    .filter((language) => language !== "unknown")
    .toSorted()
    .slice(0, 64);
}

function emptyResult(
  input: CodeIntelligenceWorkerInput,
  coverage: ProjectCodeCoverage,
  index: ProjectCodeIndexInfo,
): ProjectCodeQueryResult {
  return {
    operation: input.query.operation,
    checkoutPath: input.checkoutPath,
    matches: [],
    nodes: [],
    edges: [],
    files: [],
    unresolvedReferences: [],
    selection: { state: "not-required", candidates: [] },
    sourceDigests: [],
    stats: null,
    coverage,
    index,
  };
}

async function inspectFreshness(
  input: CodeIntelligenceWorkerInput,
  listedPaths: ReadonlyArray<string>,
  { CodeGraph, detectLanguage, getSupportedLanguages }: CodeGraphModule,
): Promise<ProjectCodeQueryResult> {
  const languages = getSupportedLanguages();
  const supported = new Set(languages);
  const commit = headCommit(input.checkoutPath);
  const baseCoverage = {
    catalogRevision: CATALOG_REVISION,
    relationSemantics: "static-candidates" as const,
    columnEncoding: "utf16-code-units" as const,
    languages: [...languages],
    filesListed: input.filesListed,
    filesSkipped: 0,
    filesUnsupported: 0,
    filesFailed: 0,
    resultLimitReached: false,
  };
  if (!CodeGraph.isInitialized(input.checkoutPath)) {
    return emptyResult(
      input,
      {
        ...baseCoverage,
        state: "unavailable",
        filesIndexed: 0,
        indexedLanguages: [],
        pendingReferences: 0,
        limitations: ["This checkout has not been indexed yet. The first code query indexes it."],
      },
      {
        state: "unindexed",
        indexedCommit: null,
        headCommit: commit,
        generation: 0,
        indexedAt: null,
        changedFiles: 0,
        changedPaths: [],
      },
    );
  }
  const graph = await CodeGraph.open(input.checkoutPath, { sync: false, readOnly: true });
  try {
    const meta = readIndexMeta(input.checkoutPath);
    const changed = changedSinceIndex(input.checkoutPath, graph, listedPaths, (path) => {
      const language = detectLanguage(path);
      return language !== "unknown" && supported.has(language);
    });
    const pendingReferences = graph.getPendingReferenceCount();
    const buildState = graph.getIndexState();
    const truncated = input.listingTruncated || input.files.length > MAX_LISTED_FILES;
    const incomplete =
      truncated || pendingReferences > 0 || (buildState !== null && buildState !== "complete");
    const limitations: string[] = [];
    if (changed.length > 0)
      limitations.push(
        `${changed.length} source ${changed.length === 1 ? "file has" : "files have"} changed since the last index. The next code query re-indexes them.`,
      );
    if (truncated) limitations.push("Workspace file listing is truncated.");
    if (pendingReferences > 0)
      limitations.push(
        "The graph index has unresolved pending references from an interrupted resolution pass.",
      );
    if (buildState !== null && buildState !== "complete")
      limitations.push(`The last full index run reported '${buildState}'.`);
    const listed = new Set(listedPaths);
    const indexedFiles = graph.getFiles().filter((file) => listed.has(file.path));
    return emptyResult(
      input,
      {
        ...baseCoverage,
        state: changed.length > 0 ? "stale" : incomplete ? "partial" : "complete",
        filesIndexed: indexedFiles.length,
        indexedLanguages: indexedLanguages(indexedFiles),
        pendingReferences,
        limitations,
      },
      {
        state: changed.length > 0 ? "stale" : incomplete ? "partial" : "ready",
        indexedCommit: meta.commit,
        headCommit: commit,
        generation: meta.generation,
        indexedAt: meta.indexedAt,
        changedFiles: changed.length,
        changedPaths: changed.slice(0, 20).map((path) => path.slice(0, 2048)),
      },
    );
  } finally {
    graph.close();
  }
}
