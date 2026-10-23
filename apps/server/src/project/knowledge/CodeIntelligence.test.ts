// @effect-diagnostics nodeBuiltinImport:off - fixtures use isolated temporary checkouts and verify source bytes against SHA-256 digests.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeWorkerThreads from "node:worker_threads";

import * as NodeCryptoEffect from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, OrchestrationV2AppThread, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import * as CodeIntelligence from "./CodeIntelligence.ts";
import * as FileHistory from "./FileHistory.ts";

const projectId = ProjectId.make("project:code-intelligence");
const threadId = ThreadId.make("thread:code-intelligence");
const worktreeThreadId = ThreadId.make("thread:code-intelligence-worktree");
const codeGraphRequirePath = NodeURL.fileURLToPath(
  new URL("../../../package.json", import.meta.url),
);

class FixtureSetupFailed extends Schema.TaggedError<FixtureSetupFailed>()("FixtureSetupFailed", {
  cause: Schema.Defect(),
}) {}

async function makeFixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-code-intelligence-"));
  const worktree = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-code-intelligence-worktree-"),
  );
  await NodeFSP.mkdir(NodePath.join(root, "src"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(worktree, "src"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(root, ".codegraph-t3-copy"), { recursive: true });
  const typescriptDefinition = 'const prefix = "🧪é"; export function greet() { return prefix; }\n';
  const typescriptCaller = [
    'import { greet as sayHello } from "./defs";',
    "// sayHello() is mentioned in a comment.",
    'const example = "sayHello()";',
    'export function caller() { const marker = "🧪é"; return sayHello(); }',
    'export function shadowed() { const sayHello = () => "local"; return sayHello(); }',
  ].join("\n");
  const goSource = [
    "package example",
    'func greet() string { return "hello" }',
    'func caller() string { _ = "🧪é"; return greet() }',
  ].join("\n");
  const pythonSource = [
    "def greet():",
    '    return "hello"',
    "def caller():",
    '    marker = "🧪é"; return greet()',
  ].join("\n");
  const worktreeSource = "export function workOnly() { return 2; }\n";
  await NodeFSP.writeFile(NodePath.join(root, "src/defs.ts"), typescriptDefinition);
  await NodeFSP.writeFile(NodePath.join(root, "src/use.ts"), typescriptCaller);
  await NodeFSP.writeFile(NodePath.join(root, "src/main.go"), goSource);
  await NodeFSP.writeFile(NodePath.join(root, "src/main.py"), pythonSource);
  await NodeFSP.writeFile(NodePath.join(root, ".codegraph-t3-copy/user.txt"), "User data.\n");
  await NodeFSP.writeFile(NodePath.join(worktree, "src/work.ts"), worktreeSource);
  return { root, worktree, typescriptDefinition, typescriptCaller, goSource, pythonSource };
}

function withFixture<A, E, R>(
  use: (fixture: Awaited<ReturnType<typeof makeFixture>>) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: makeFixture,
      catch: (cause) => new FixtureSetupFailed({ cause }),
    }),
    use,
    ({ root, worktree }) =>
      Effect.promise(async () => {
        await NodeFSP.rm(root, { recursive: true, force: true });
        await NodeFSP.rm(worktree, { recursive: true, force: true });
      }),
  );
}

it.effect(
  "serves bounded multilingual graph queries from the authorized project and selected worktree",
  () =>
    withFixture(
      ({ root, worktree, typescriptDefinition, typescriptCaller, goSource, pythonSource }) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await NodeFSP.symlink(worktree, NodePath.join(root, "linked-worktree"));
            await NodeFSP.symlink(
              NodePath.join(worktree, "src/work.ts"),
              NodePath.join(root, "src/linked-work.ts"),
            );
          });
          const project = {
            projectId,
            workspaceRoot: root,
            deletedAt: null,
          } as unknown as ProjectStore.ProjectRow;
          const mainThread = {
            id: threadId,
            projectId,
            worktreePath: null,
          } as unknown as OrchestrationV2AppThread;
          const worktreeThread = {
            id: worktreeThreadId,
            projectId,
            worktreePath: worktree,
          } as unknown as OrchestrationV2AppThread;
          let includeGeneratedInventoryFiles = false;
          const dependencies = Layer.mergeAll(
            Layer.mock(ProjectStore.ProjectStoreV2)({
              get: () => Effect.succeedSome(project),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: (requestedThreadId) =>
                Effect.succeed(
                  requestedThreadId === worktreeThreadId ? worktreeThread : mainThread,
                ),
            }),
            Layer.mock(WorkspacePaths.WorkspacePaths)({
              normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
              resolveRelativePathWithinRoot: ({ relativePath }) =>
                Effect.succeed({ absolutePath: relativePath, relativePath }),
            }),
            Layer.mock(WorkspaceEntries.WorkspaceEntries)({
              refresh: () => Effect.void,
              list: ({ cwd }) =>
                Effect.promise(async () => {
                  const entries =
                    cwd === worktree
                      ? ["src/work.ts"]
                      : ["src/defs.ts", "src/use.ts", "src/main.go", "src/main.py"];
                  if (
                    cwd === root &&
                    includeGeneratedInventoryFiles &&
                    (await NodeFSP.stat(NodePath.join(root, ".codegraph-t3/.gitignore"))
                      .then(() => true)
                      .catch(() => false))
                  ) {
                    entries.push(".codegraph-t3/.gitignore", ".codegraph-t3-copy/user.txt");
                  }
                  return {
                    entries: entries.map((path) => ({ path, kind: "file" as const })),
                    truncated: false,
                  };
                }),
            }),
          );
          const provided = Layer.provide(CodeIntelligence.layer, dependencies);
          const runQuery = (
            query: Parameters<CodeIntelligence.CodeIntelligence["Service"]["query"]>[0]["query"],
            selectedThreadId?: ThreadId,
          ) =>
            Effect.gen(function* () {
              const intelligence = yield* CodeIntelligence.CodeIntelligence;
              return yield* intelligence.query({
                projectId,
                ...(selectedThreadId ? { threadId: selectedThreadId } : {}),
                query,
              });
            }).pipe(Effect.provide(provided));

          yield* Effect.promise(async () => {
            const seed = new NodeWorkerThreads.Worker(
              `const { parentPort, workerData } = require("node:worker_threads");
               const { createRequire } = require("node:module");
               const sdk = createRequire(workerData.requirePath)("@colbymchenry/codegraph");
               (async () => {
                 const graph = await sdk.CodeGraph.init(workerData.root, { index: false });
                 try { await graph.sync(); } finally { graph.close(); }
                 parentPort.postMessage({ ready: true });
               })().catch((error) => parentPort.postMessage({ error: String(error) }));`,
              {
                eval: true,
                workerData: { requirePath: codeGraphRequirePath, root },
                env: { ...process.env, CODEGRAPH_DIR: ".codegraph-t3" },
              },
            );
            await new Promise<void>((resolve, reject) => {
              seed.once("error", reject);
              seed.on(
                "message",
                (message: { readonly error?: string; readonly ready?: boolean }) => {
                  if (message.error !== undefined) reject(new Error(message.error));
                  else if (message.ready) resolve();
                },
              );
              seed.once("exit", (code) => {
                if (code !== 0) reject(new Error(`Seed index worker exited with code ${code}.`));
              });
            });
          });

          const staleLinkedSymbols = yield* runQuery({
            operation: "symbols",
            name: "workOnly",
          });
          assert.equal(staleLinkedSymbols.nodes.length, 0);
          const persistedLinkedSymbols = yield* Effect.promise(
            () =>
              new Promise<number>((resolve, reject) => {
                const inspect = new NodeWorkerThreads.Worker(
                  `const { parentPort, workerData } = require("node:worker_threads");
                   const { createRequire } = require("node:module");
                   const sdk = createRequire(workerData.requirePath)("@colbymchenry/codegraph");
                   (async () => {
                     const graph = await sdk.CodeGraph.open(workerData.root, { sync: false });
                     try { parentPort.postMessage(graph.getNodesByName("workOnly").length); }
                     finally { graph.close(); }
                   })().catch((error) => parentPort.postMessage({ error: String(error) }));`,
                  {
                    eval: true,
                    workerData: { requirePath: codeGraphRequirePath, root },
                    env: { ...process.env, CODEGRAPH_DIR: ".codegraph-t3" },
                  },
                );
                inspect.once("error", reject);
                inspect.on("message", (message: number | { readonly error: string }) => {
                  if (typeof message === "number") resolve(message);
                  else reject(new Error(message.error));
                });
                inspect.once("exit", (code) => {
                  if (code !== 0) reject(new Error(`Inspect worker exited with code ${code}.`));
                });
              }),
          );
          assert.equal(persistedLinkedSymbols, 0);
          yield* Effect.promise(() =>
            NodeFSP.rm(NodePath.join(root, ".codegraph-t3"), { recursive: true, force: true }),
          );

          const [concurrentStatus, concurrentSearch] = yield* Effect.all(
            [runQuery({ operation: "status" }), runQuery({ operation: "search", text: "greet" })],
            { concurrency: 2 },
          );
          assert.equal(concurrentStatus.coverage.state, "complete");
          assert.equal(concurrentStatus.coverage.filesListed, 4);
          assert.equal(concurrentStatus.coverage.filesUnsupported, 0);
          assert.ok(concurrentSearch.matches.some((match) => match.symbol.name === "greet"));

          const toolLayer = McpHttpServer.layerProjectCodeToolkit.pipe(
            Layer.provide(provided),
            Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
            Layer.provide(Layer.mock(FileHistory.FileHistory)({})),
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(NodeCryptoEffect.layer),
            Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
          );
          const toolResult = yield* Effect.gen(function* () {
            const server = yield* McpServer.McpServer;
            return yield* server
              .callTool({
                name: "t3_project_code_query",
                arguments: {
                  projectId,
                  query: { operation: "symbols", name: "greet" },
                },
              })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, {
                  environmentId: EnvironmentId.make("code-intelligence-test"),
                  requestNamespace: "client:code-intelligence-test",
                  thread: undefined,
                  client: {
                    sessionId: "code-intelligence-test",
                    label: "Code intelligence test",
                    access: "read-only",
                  },
                  issuedAt: 0,
                  capabilities: new Set<McpInvocationContext.McpCapability>([
                    "orchestration",
                    "project-code",
                  ]),
                }),
                Effect.provideService(
                  McpSchema.McpServerClient,
                  McpSchema.McpServerClient.of({
                    clientId: 1,
                    protocolVersion: "2025-06-18",
                    clientCapabilities: {},
                    clientInfo: { name: "code-intelligence-test", version: "1" },
                    initializePayload: {
                      protocolVersion: "2025-06-18",
                      capabilities: {},
                      clientInfo: { name: "code-intelligence-test", version: "1" },
                    },
                    getClient: Effect.die("unused"),
                  }),
                ),
              );
          }).pipe(Effect.provide(toolLayer));
          assert.equal(toolResult.isError, false);
          assert.ok(
            (
              toolResult.structuredContent as {
                readonly nodes: ReadonlyArray<{ readonly name: string }>;
              }
            ).nodes.some(({ name }) => name === "greet"),
          );

          const linkedSymbols = yield* runQuery({ operation: "symbols", name: "workOnly" });
          assert.equal(linkedSymbols.nodes.length, 0);
          const outsidePathError = yield* Effect.flip(
            runQuery({
              operation: "symbols",
              name: "workOnly",
              filePath: "src/linked-work.ts",
            }),
          );
          assert.equal(outsidePathError._tag, "CodeIntelligencePathOutsideCheckout");

          const outline = yield* runQuery({ operation: "symbols", filePath: "src/use.ts" });
          assert.deepEqual(
            outline.nodes.map((node) => [node.name, node.path]),
            [
              ["example", "src/use.ts"],
              ["caller", "src/use.ts"],
              ["shadowed", "src/use.ts"],
              ["sayHello", "src/use.ts"],
            ],
          );

          const callerQuery = yield* runQuery({
            operation: "callers",
            symbol: { name: "greet", filePath: "src/defs.ts" },
          });
          assert.equal(callerQuery.selection.state, "matched");
          assert.ok(
            callerQuery.nodes.some((node) => node.name === "caller" && node.path === "src/use.ts"),
          );
          const callEdge = callerQuery.edges.find((edge) => edge.kind === "calls");
          assert.ok(callEdge);
          assert.equal(callEdge.resolvedBy, "import");
          assert.equal(callEdge.provenance, null);
          assert.equal(callEdge.evidenceGrade, "static-candidate");
          assert.ok(callerQuery.edges.every((edge) => edge.evidenceGrade !== "compiler-indexed"));
          const caller = callerQuery.nodes.find((node) => node.name === "caller");
          assert.ok(caller);
          const callerCall = callerQuery.edges.find(
            (edge) => edge.source === caller.id && edge.kind === "calls",
          );
          assert.ok(callerCall);
          assert.equal(
            callerCall.column,
            typescriptCaller.split("\n")[callerCall.line! - 1]!.indexOf("sayHello()"),
          );
          assert.equal(
            callerQuery.nodes.find((node) => node.name === "greet" && node.path === "src/defs.ts")
              ?.startColumn,
            typescriptDefinition.indexOf("function"),
          );
          assert.ok(
            callerQuery.sourceDigests.some(
              (source) => source.path === "src/defs.ts" && source.verified,
            ),
          );
          assert.equal(callerQuery.coverage.relationSemantics, "static-candidates");
          assert.equal(callerQuery.coverage.columnEncoding, "utf16-code-units");
          assert.ok(
            callerQuery.coverage.limitations.some((limitation) =>
              limitation.includes("shadowed names"),
            ),
          );
          assert.equal(callerQuery.coverage.state, "complete");

          const reaches = yield* runQuery({
            operation: "path",
            from: { name: "caller", filePath: "src/use.ts" },
            to: { name: "greet", filePath: "src/defs.ts" },
          });
          assert.equal(reaches.pathSearch?.found, true);
          assert.equal(reaches.pathSearch?.maxDepth, 6);
          assert.equal(reaches.pathSearch?.walkTruncated, false);
          assert.equal(reaches.pathSearch?.unresolvedEndpoint, null);
          // The route runs from `from` to `to`, one edge per hop.
          assert.deepEqual(
            reaches.nodes.map((node) => node.name),
            ["caller", "greet"],
          );
          assert.deepEqual(
            reaches.edges.map((edge) => [edge.source, edge.target]),
            [[reaches.nodes[0]!.id, reaches.nodes[1]!.id]],
          );
          const reverse = yield* runQuery({
            operation: "path",
            from: { name: "greet", filePath: "src/defs.ts" },
            to: { name: "caller", filePath: "src/use.ts" },
            depth: 2,
          });
          assert.equal(reverse.pathSearch?.found, false);
          assert.equal(reverse.pathSearch?.maxDepth, 2);
          assert.deepEqual(reverse.nodes, []);
          const ambiguousTarget = yield* runQuery({
            operation: "path",
            from: { name: "caller", filePath: "src/use.ts" },
            to: { name: "greet" },
          });
          assert.equal(ambiguousTarget.selection.state, "ambiguous");
          assert.equal(ambiguousTarget.pathSearch?.unresolvedEndpoint, "to");
          assert.equal(ambiguousTarget.pathSearch?.found, false);

          const ambiguous = yield* runQuery({ operation: "callers", symbol: { name: "greet" } });
          assert.equal(ambiguous.selection.state, "ambiguous");
          assert.ok(ambiguous.selection.candidates.some((node) => node.language === "go"));
          assert.ok(ambiguous.selection.candidates.some((node) => node.language === "python"));
          assert.equal(ambiguous.edges.length, 0);

          const goCallers = yield* runQuery({
            operation: "callers",
            symbol: { name: "greet", filePath: "src/main.go" },
          });
          assert.ok(
            goCallers.nodes.some((node) => node.name === "caller" && node.language === "go"),
          );
          const goCall = goCallers.edges.find((edge) => edge.kind === "calls");
          assert.ok(goCall);
          assert.equal(goCall.resolvedBy, "exact-match");
          assert.equal(goCall.column, goSource.split("\n")[goCall.line! - 1]!.indexOf("greet()"));
          const pythonCallers = yield* runQuery({
            operation: "callers",
            symbol: { name: "greet", filePath: "src/main.py" },
          });
          assert.ok(
            pythonCallers.nodes.some(
              (node) => node.name === "caller" && node.language === "python",
            ),
          );
          const pythonCall = pythonCallers.edges.find((edge) => edge.kind === "calls");
          assert.ok(pythonCall);
          assert.equal(
            pythonCall.column,
            pythonSource.split("\n")[pythonCall.line! - 1]!.indexOf("greet()"),
          );

          const search = yield* runQuery({ operation: "search", text: "greet", limit: 20 });
          assert.ok(search.matches.some((match) => match.symbol.language === "typescript"));
          assert.ok(search.matches.some((match) => match.symbol.language === "go"));
          assert.ok(search.matches.some((match) => match.symbol.language === "python"));
          assert.ok(search.coverage.languages.includes("typescript"));
          assert.ok(search.coverage.languages.includes("go"));
          assert.ok(search.coverage.languages.includes("python"));
          // The catalog is what the analyzer supports; only these were indexed in the checkout.
          assert.ok(search.coverage.languages.includes("rust"));
          assert.deepEqual(search.coverage.indexedLanguages, ["go", "python", "typescript"]);

          const boundedSearch = yield* runQuery({ operation: "search", text: "greet", limit: 1 });
          assert.equal(boundedSearch.matches.length, 1);
          assert.equal(boundedSearch.coverage.resultLimitReached, true);
          assert.equal(boundedSearch.coverage.state, "partial");

          const dependenciesResult = yield* runQuery({
            operation: "dependencies",
            filePath: "src/use.ts",
            direction: "imports",
          });
          assert.ok(dependenciesResult.files.some((file) => file.path === "src/defs.ts"));

          includeGeneratedInventoryFiles = true;
          const status = yield* runQuery({ operation: "status" });
          assert.equal(status.stats?.files, 4);
          assert.equal(status.coverage.filesListed, 5);
          assert.equal(status.coverage.filesUnsupported, 1);
          const repeatedStatus = yield* runQuery({ operation: "status" });
          assert.equal(repeatedStatus.coverage.filesListed, 5);
          assert.equal(repeatedStatus.coverage.filesUnsupported, 1);
          const graphDirectoryExists = yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(root, ".codegraph-t3")).then(() => true),
          );
          const standardIndexExists = yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(root, ".codegraph")).then(
              () => true,
              () => false,
            ),
          );
          const rootGitignoreExists = yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(root, ".gitignore")).then(
              () => true,
              () => false,
            ),
          );
          assert.equal(graphDirectoryExists, true);
          assert.equal(standardIndexExists, false);
          assert.equal(rootGitignoreExists, false);

          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(root, "src/main.go"),
              'package example\nfunc renamed() string { return "changed" }\n',
            ),
          );
          const renamed = yield* runQuery({
            operation: "symbols",
            name: "renamed",
            filePath: "src/main.go",
          });
          assert.ok(renamed.nodes.some((node) => node.name === "renamed"));
          const stale = yield* runQuery({
            operation: "symbols",
            name: "greet",
            filePath: "src/main.go",
          });
          assert.equal(stale.nodes.length, 0);
          yield* Effect.promise(() => NodeFSP.rm(NodePath.join(root, "src/main.py")));
          const afterDelete = yield* runQuery({ operation: "status" });
          assert.equal(afterDelete.stats?.files, 3);

          const worktreeSymbols = yield* runQuery(
            { operation: "symbols", name: "workOnly" },
            worktreeThreadId,
          );
          assert.ok(worktreeSymbols.nodes.some((node) => node.path === "src/work.ts"));
          assert.equal(
            worktreeSymbols.nodes.some((node) => node.name === "greet"),
            false,
          );
          assert.equal(worktreeSymbols.checkoutPath, worktree);

          const sourceDigest = NodeCrypto.createHash("sha256")
            .update(Buffer.from(typescriptDefinition))
            .digest("hex");
          assert.equal(
            callerQuery.sourceDigests.find((source) => source.path === "src/defs.ts")?.digest,
            sourceDigest,
          );
          assert.ok(callerQuery.nodes.length <= 100);
          assert.ok(callerQuery.edges.length <= 100);

          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(root, "src/defs.ts"),
              Buffer.concat([Buffer.from(typescriptDefinition), Buffer.from([0xff])]),
            ),
          );
          const invalidUtf8 = yield* runQuery({
            operation: "dependencies",
            filePath: "src/use.ts",
            direction: "imports",
          });
          assert.equal(
            invalidUtf8.sourceDigests.find((source) => source.path === "src/defs.ts")?.verified,
            false,
          );
          assert.equal(invalidUtf8.coverage.state, "stale");

          yield* Effect.promise(async () => {
            await NodeFSP.rm(NodePath.join(root, ".codegraph-t3"), {
              recursive: true,
              force: true,
            });
            await NodeFSP.rm(NodePath.join(worktree, ".codegraph-t3"), {
              recursive: true,
              force: true,
            });
            await NodeFSP.symlink(worktree, NodePath.join(root, ".codegraph-t3"));
          });
          const indexPathError = yield* Effect.flip(runQuery({ operation: "status" }));
          assert.equal(indexPathError._tag, "CodeIntelligencePathOutsideCheckout");
          assert.equal(
            yield* Effect.promise(() =>
              NodeFSP.stat(NodePath.join(worktree, ".codegraph-t3")).then(
                () => true,
                () => false,
              ),
            ),
            false,
          );
        }),
    ),
);

it.effect("runs a graph query while the checkout lease is held", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const project = {
        projectId,
        workspaceRoot: fixture.root,
        deletedAt: null,
      } as unknown as ProjectStore.ProjectRow;
      const dependencies = Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedSome(project) }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThread: () => Effect.die("unused") }),
        Layer.mock(WorkspacePaths.WorkspacePaths)({
          normalizeWorkspaceRoot: () => Effect.succeed(fixture.root),
          resolveRelativePathWithinRoot: ({ relativePath }) =>
            Effect.succeed({ absolutePath: relativePath, relativePath }),
        }),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({
          refresh: () => Effect.void,
          list: () =>
            Effect.succeed({
              entries: ["src/defs.ts", "src/use.ts", "src/main.go", "src/main.py"].map((path) => ({
                path,
                kind: "file" as const,
              })),
              truncated: false,
            }),
        }),
      );
      const provided = Layer.provide(CodeIntelligence.layer, dependencies);
      const checkoutLeaseStarted = yield* Deferred.make<void>();
      const releaseCheckoutLease = yield* Deferred.make<void>();
      const checkoutLease = yield* withWorkspaceLease(
        fixture.root,
        Deferred.succeed(checkoutLeaseStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCheckoutLease)),
        ),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(checkoutLeaseStarted);

      const result = yield* Effect.gen(function* () {
        const intelligence = yield* CodeIntelligence.CodeIntelligence;
        return yield* intelligence.query({
          projectId,
          query: { operation: "symbols", name: "greet" },
        });
      }).pipe(Effect.provide(provided));
      yield* Deferred.succeed(releaseCheckoutLease, undefined);
      yield* Fiber.await(checkoutLease);
      assert.ok(result.nodes.some(({ name }) => name === "greet"));
    }),
  ),
);

it.effect("reports index freshness against the checkout and walks usages to reaching tests", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const testSource =
        'import { caller } from "./use";\nexport function checksCaller() { return caller(); }\n';
      const head = yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(fixture.root, "src/defs.test.ts"), testSource);
        const git = (...args: string[]) =>
          NodeChildProcess.execFileSync(
            "git",
            ["-c", "user.email=t3@example.com", "-c", "user.name=T3", ...args],
            { cwd: fixture.root, encoding: "utf8" },
          ).trim();
        git("init", "-q");
        git("add", "src");
        git("commit", "-qm", "fixture");
        return git("rev-parse", "HEAD");
      });
      const project = {
        projectId,
        workspaceRoot: fixture.root,
        deletedAt: null,
      } as unknown as ProjectStore.ProjectRow;
      const provided = Layer.provide(
        CodeIntelligence.layer,
        Layer.mergeAll(
          Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedSome(project) }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThread: () => Effect.die("unused") }),
          Layer.mock(WorkspacePaths.WorkspacePaths)({
            normalizeWorkspaceRoot: () => Effect.succeed(fixture.root),
            resolveRelativePathWithinRoot: ({ relativePath }) =>
              Effect.succeed({ absolutePath: relativePath, relativePath }),
          }),
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({
            refresh: () => Effect.void,
            list: () =>
              Effect.succeed({
                entries: ["src/defs.ts", "src/use.ts", "src/defs.test.ts"].map((path) => ({
                  path,
                  kind: "file" as const,
                })),
                truncated: false,
              }),
          }),
        ),
      );
      const run = (
        query: Parameters<CodeIntelligence.CodeIntelligence["Service"]["query"]>[0]["query"],
      ) =>
        Effect.flatMap(CodeIntelligence.CodeIntelligence, (intelligence) =>
          intelligence.query({ projectId, query }),
        ).pipe(Effect.provide(provided));

      // Freshness never indexes: an unindexed checkout stays unindexed.
      assert.equal((yield* run({ operation: "freshness" })).index?.state, "unindexed");
      assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.root, ".codegraph-t3")));

      const indexed = yield* run({ operation: "status" });
      assert.deepInclude(indexed.index, { state: "ready", indexedCommit: head, generation: 1 });
      assert.deepInclude((yield* run({ operation: "freshness" })).index, {
        state: "ready",
        changedFiles: 0,
        indexedCommit: head,
        headCommit: head,
      });

      const name = (result: typeof indexed, id: string) =>
        result.nodes.find((node) => node.id === id)?.name;
      const tests = yield* run({
        operation: "tests",
        symbol: { name: "greet", filePath: "src/defs.ts" },
      });
      assert.deepEqual(
        tests.symbolGroups?.[0]?.tests.map((id) => name(tests, id)),
        ["checksCaller"],
      );
      // The chain through the intermediate caller comes back so a client can show the hops.
      assert.ok(tests.nodes.some((node) => node.name === "caller"));

      const affected = yield* run({
        operation: "affected",
        filePath: "src/defs.ts",
        lineRanges: [{ start: 1, end: 1 }],
      });
      const group = affected.symbolGroups?.find(
        (entry) => name(affected, entry.symbol) === "greet",
      );
      assert.ok(group);
      assert.include(
        group.callers.map((id) => name(affected, id)),
        "caller",
      );
      assert.deepEqual(
        group.tests.map((id) => name(affected, id)),
        ["checksCaller"],
      );

      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(fixture.root, "src/defs.ts"),
          'export function greet() { return "changed"; }\n',
        ),
      );
      assert.deepInclude((yield* run({ operation: "freshness" })).index, {
        state: "stale",
        changedFiles: 1,
        changedPaths: ["src/defs.ts"],
        indexedCommit: head,
      });

      // While another query holds the index, freshness answers instead of queueing.
      const leaseHeld = yield* Deferred.make<void>();
      const releaseLease = yield* Deferred.make<void>();
      const lease = yield* withWorkspaceLease(
        NodePath.join(fixture.root, ".codegraph-t3"),
        Deferred.succeed(leaseHeld, undefined).pipe(Effect.andThen(Deferred.await(releaseLease))),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(leaseHeld);
      assert.equal((yield* run({ operation: "freshness" })).index?.state, "indexing");
      yield* Deferred.succeed(releaseLease, undefined);
      yield* Fiber.await(lease);

      assert.deepInclude((yield* run({ operation: "status" })).index, {
        state: "ready",
        generation: 2,
      });
      assert.equal((yield* run({ operation: "freshness" })).index?.changedFiles, 0);
    }),
  ),
);

function checkoutService(root: string, listed: () => ReadonlyArray<string>) {
  const project = {
    projectId,
    workspaceRoot: root,
    deletedAt: null,
  } as unknown as ProjectStore.ProjectRow;
  const provided = Layer.provide(
    CodeIntelligence.layer,
    Layer.mergeAll(
      Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedSome(project) }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThread: () => Effect.die("unused") }),
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        normalizeWorkspaceRoot: () => Effect.succeed(root),
        resolveRelativePathWithinRoot: ({ relativePath }) =>
          Effect.succeed({ absolutePath: relativePath, relativePath }),
      }),
      Layer.mock(WorkspaceEntries.WorkspaceEntries)({
        refresh: () => Effect.void,
        list: () =>
          Effect.sync(() => ({
            entries: listed().map((path) => ({ path, kind: "file" as const })),
            truncated: false,
          })),
      }),
    ),
  );
  return (query: Parameters<CodeIntelligence.CodeIntelligence["Service"]["query"]>[0]["query"]) =>
    Effect.flatMap(CodeIntelligence.CodeIntelligence, (intelligence) =>
      intelligence.query({ projectId, query }),
    ).pipe(Effect.provide(provided));
}

function indexedSymbolCount(root: string, name: string) {
  return Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const inspect = new NodeWorkerThreads.Worker(
          `const { parentPort, workerData } = require("node:worker_threads");
           const { createRequire } = require("node:module");
           const sdk = createRequire(workerData.requirePath)("@colbymchenry/codegraph");
           (async () => {
             const graph = await sdk.CodeGraph.open(workerData.root, { sync: false, readOnly: true });
             try { parentPort.postMessage(graph.getNodesByName(workerData.name).length); }
             finally { graph.close(); }
           })().catch((error) => parentPort.postMessage({ error: String(error) }));`,
          {
            eval: true,
            workerData: { requirePath: codeGraphRequirePath, root, name },
            env: { ...process.env, CODEGRAPH_DIR: ".codegraph-t3" },
          },
        );
        inspect.once("error", reject);
        inspect.on("message", (message: number | { readonly error: string }) => {
          if (typeof message === "number") resolve(message);
          else reject(new Error(message.error));
        });
      }),
  );
}

it.effect("refuses a symlinked index child instead of writing through it", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const victim = NodePath.join(fixture.worktree, "victim");
      const run = checkoutService(fixture.root, () => ["src/defs.ts", "src/use.ts"]);
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(victim, "untouched");
        await NodeFSP.mkdir(NodePath.join(fixture.root, ".codegraph-t3"));
      });
      for (const child of ["t3-index.json", "codegraph.db-wal"]) {
        const link = NodePath.join(fixture.root, ".codegraph-t3", child);
        yield* Effect.promise(() => NodeFSP.symlink(victim, link));
        const result = yield* Effect.result(run({ operation: "status" }));
        assert.equal(yield* Effect.promise(() => NodeFSP.readFile(victim, "utf8")), "untouched");
        assert.equal(result._tag, "Failure", child);
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "CodeIntelligencePathOutsideCheckout", child);
        }
        yield* Effect.promise(() => NodeFSP.rm(link));
      }
    }),
  ),
);

it.effect("never widens an empty canonical allowlist into a full checkout scan", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.symlink(
          NodePath.join(fixture.worktree, "src/work.ts"),
          NodePath.join(fixture.root, "src/linked-work.ts"),
        ),
      );
      const run = checkoutService(fixture.root, () => ["src/linked-work.ts"]);
      const status = yield* run({ operation: "status" });
      assert.equal(status.coverage.filesIndexed, 0);
      assert.equal(yield* indexedSymbolCount(fixture.root, "workOnly"), 0);
      assert.equal(yield* indexedSymbolCount(fixture.root, "greet"), 0);
    }),
  ),
);

it.effect("compares oversize and non-UTF-8 sources the way the index hashed them", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const big = NodePath.join(fixture.root, "src/big.ts");
      const latin = NodePath.join(fixture.root, "src/latin.ts");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(
          big,
          `export function huge() { return 1; }\n/*${"x".repeat(1024 * 1024)}*/\n`,
        );
        await NodeFSP.writeFile(
          latin,
          Buffer.concat([
            Buffer.from("export function latin() { return 1; }\n// "),
            Buffer.from([0xe9, 0xff]),
            Buffer.from("\n"),
          ]),
        );
      });
      const run = checkoutService(fixture.root, () => [
        "src/defs.ts",
        "src/big.ts",
        "src/latin.ts",
      ]);
      yield* run({ operation: "status" });
      yield* Effect.promise(async () => {
        for (const path of [big, latin]) {
          const later = (await NodeFSP.stat(path)).mtimeMs / 1000 + 60;
          await NodeFSP.utimes(path, later, later);
        }
      });
      const freshness = yield* run({ operation: "freshness" });
      assert.deepEqual(freshness.index?.changedPaths, []);
      const affected = yield* run({ operation: "affected", filePath: "src/big.ts" });
      assert.deepEqual(affected.sourceDigests, [
        { path: "src/big.ts", digest: "", verified: true },
      ]);
      assert.notEqual(affected.coverage.state, "stale");
    }),
  ),
);

it.effect("reports freshness coverage with the same classification as a query", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(fixture.root, "README.md"), "# Fixture\n"),
      );
      const run = checkoutService(fixture.root, () => ["src/defs.ts", "src/use.ts", "README.md"]);
      const status = yield* run({ operation: "status" });
      const freshness = yield* run({ operation: "freshness" });
      const counts = (result: typeof status) => ({
        state: result.coverage.state,
        filesUnsupported: result.coverage.filesUnsupported,
        filesSkipped: result.coverage.filesSkipped,
        filesFailed: result.coverage.filesFailed,
      });
      assert.deepEqual(counts(status), {
        state: "partial",
        filesUnsupported: 1,
        filesSkipped: 0,
        filesFailed: 0,
      });
      assert.deepEqual(counts(freshness), counts(status));
      assert.equal(freshness.index?.state, "partial");
    }),
  ),
);

it.effect("keeps the nearest relations when a traversal hits its budget", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const source = [
        "export function target() { return 1; }",
        ...[1, 2, 3].flatMap((index) => [
          `export function near${index}() { return target(); }`,
          `export function far${index}() { return near${index}(); }`,
        ]),
      ].join("\n");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(fixture.root, "src/chain.ts"), `${source}\n`),
      );
      const run = checkoutService(fixture.root, () => ["src/chain.ts"]);
      for (const operation of ["callers", "impact"] as const) {
        const result = yield* run({
          operation,
          symbol: { name: "target", filePath: "src/chain.ts" },
          depth: 2,
          limit: 3,
        });
        assert.deepEqual(
          result.nodes.map((node) => node.name).toSorted(),
          ["near1", "near2", "target"],
          operation,
        );
        assert.equal(result.coverage.resultLimitReached, true, operation);
      }
    }),
  ),
);

async function writeGeneratedSources(root: string, count: number) {
  await NodeFSP.mkdir(NodePath.join(root, "src/generated"), { recursive: true });
  const files = Array.from({ length: count }, (_, index) => `src/generated/g${index}.py`);
  await Promise.all(
    files.map((file, index) =>
      NodeFSP.writeFile(
        NodePath.join(root, file),
        `def generated_${index}():\n    return ${index}\n`,
      ),
    ),
  );
  return files;
}

/** Resolves with the pid the SDK writes into its index lock once a sync holds it. */
function indexLockHolder(root: string) {
  const directory = NodePath.join(root, ".codegraph-t3");
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      await NodeFSP.mkdir(directory, { recursive: true });
      let resolveHolder!: (pid: number) => void;
      const holder = new Promise<number>((resolve) => {
        resolveHolder = resolve;
      });
      const inspect = () => {
        try {
          const pid = Number(
            NodeFS.readFileSync(NodePath.join(directory, "codegraph.lock"), "utf8"),
          );
          if (Number.isSafeInteger(pid) && pid > 0) resolveHolder(pid);
        } catch {
          // Not written yet; the next directory event reads it again.
        }
      };
      const watcher = NodeFS.watch(directory, inspect);
      inspect();
      return { watcher, holder };
    }),
    ({ holder }) => Effect.promise(() => holder),
    ({ watcher }) => Effect.sync(() => watcher.close()),
  );
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it.effect(
  "stops indexing when the query is interrupted and never serves the cut index as ready",
  () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const files = yield* Effect.promise(() => writeGeneratedSources(fixture.root, 400));
        const listed = ["src/defs.ts", ...files];
        const run = checkoutService(fixture.root, () => listed);
        const holder = yield* indexLockHolder(fixture.root).pipe(Effect.forkScoped);
        const indexing = yield* run({ operation: "status" }).pipe(Effect.forkScoped);
        const pid = yield* Fiber.join(holder);
        yield* Fiber.interrupt(indexing);
        const afterInterrupt = yield* run({ operation: "freshness" });
        assert.isBelow(afterInterrupt.coverage.filesIndexed, listed.length);
        assert.notEqual(afterInterrupt.index?.state, "ready");
        assert.isFalse(
          isProcessAlive(pid),
          "the indexing process is gone once interruption returns",
        );
        const recovered = yield* run({ operation: "status" });
        assert.equal(recovered.coverage.filesIndexed, listed.length);
        assert.equal(recovered.coverage.state, "complete");
      }),
    ),
);

it.effect("fails the query, not the server, when the analysis process aborts", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const files = yield* Effect.promise(() => writeGeneratedSources(fixture.root, 400));
      const run = checkoutService(fixture.root, () => files);
      const holder = yield* indexLockHolder(fixture.root).pipe(Effect.forkScoped);
      const indexing = yield* run({ operation: "status" }).pipe(Effect.result, Effect.forkScoped);
      const pid = yield* Fiber.join(holder);
      assert.notEqual(pid, process.pid, "analysis runs outside the server process");
      process.kill(pid, "SIGABRT");
      const result = yield* Fiber.join(indexing);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.deepInclude(result.failure, {
          _tag: "CodeIntelligenceInspectionFailed",
          reason: "worker-failed",
        });
      }
    }),
  ),
);

it.effect("answers queries when the server itself runs under node --watch", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const previous = process.env.WATCH_REPORT_DEPENDENCIES;
      process.env.WATCH_REPORT_DEPENDENCIES = "1";
      const result = yield* Effect.result(
        checkoutService(fixture.root, () => ["src/defs.ts"])({ operation: "status" }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env.WATCH_REPORT_DEPENDENCIES;
            else process.env.WATCH_REPORT_DEPENDENCIES = previous;
          }),
        ),
      );
      assert.equal(result._tag, "Success");
    }),
  ),
);

it.effect("keeps the index out of the checkout's git status", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const git = (...args: ReadonlyArray<string>) =>
        NodeChildProcess.execFileSync("git", args, { cwd: fixture.root, encoding: "utf8" });
      git("init", "--quiet");
      yield* checkoutService(fixture.root, () => ["src/defs.ts"])({ operation: "status" });
      const untracked = git("status", "--porcelain", "--untracked-files=all")
        .split("\n")
        .filter((line) => line.includes(".codegraph-t3/"));
      assert.deepEqual(untracked, []);
    }),
  ),
);

it.effect("leaves import statements out of symbol search", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const search = yield* checkoutService(fixture.root, () => ["src/defs.ts", "src/use.ts"])({
        operation: "search",
        text: "defs",
        limit: 20,
      });
      assert.deepEqual(
        search.matches.filter((match) => match.symbol.kind === "import"),
        [],
      );
    }),
  ),
);

it.effect("returns index not ready for a cold checkout without synchronizing sources", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const result = yield* checkoutService(fixture.root, () => ["src/defs.ts"])({
        operation: "symbols",
        name: "greet",
      });
      assert.equal(result.index?.state, "unindexed");
      assert.deepEqual(result.nodes, []);
    }),
  ),
);
