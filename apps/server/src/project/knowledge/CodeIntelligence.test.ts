// @effect-diagnostics nodeBuiltinImport:off - fixtures use isolated temporary checkouts and verify source bytes against SHA-256 digests.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Worker } from "node:worker_threads";

import { assert, it } from "@effect/vitest";
import { OrchestrationV2AppThread, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as CodeIntelligence from "./CodeIntelligence.ts";

const projectId = ProjectId.make("project:code-intelligence");
const threadId = ThreadId.make("thread:code-intelligence");
const worktreeThreadId = ThreadId.make("thread:code-intelligence-worktree");

class FixtureSetupFailed extends Schema.TaggedError<FixtureSetupFailed>()("FixtureSetupFailed", {
  cause: Schema.Defect(),
}) {}

async function makeFixture() {
  const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-code-intelligence-"));
  const worktree = await NodeFS.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-code-intelligence-worktree-"),
  );
  await NodeFS.mkdir(NodePath.join(root, "src"), { recursive: true });
  await NodeFS.mkdir(NodePath.join(worktree, "src"), { recursive: true });
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
  await NodeFS.writeFile(NodePath.join(root, "src/defs.ts"), typescriptDefinition);
  await NodeFS.writeFile(NodePath.join(root, "src/use.ts"), typescriptCaller);
  await NodeFS.writeFile(NodePath.join(root, "src/main.go"), goSource);
  await NodeFS.writeFile(NodePath.join(root, "src/main.py"), pythonSource);
  await NodeFS.writeFile(NodePath.join(worktree, "src/work.ts"), worktreeSource);
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
        await NodeFS.rm(root, { recursive: true, force: true });
        await NodeFS.rm(worktree, { recursive: true, force: true });
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
            await NodeFS.symlink(worktree, NodePath.join(root, "linked-worktree"));
            await NodeFS.symlink(
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
                Effect.succeed({
                  entries: (cwd === worktree
                    ? ["src/work.ts"]
                    : ["src/defs.ts", "src/use.ts", "src/main.go", "src/main.py"]
                  ).map((path) => ({ path, kind: "file" as const })),
                  truncated: false,
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
            const seed = new Worker(
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
                workerData: { requirePath: NodePath.join(process.cwd(), "package.json"), root },
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
                const inspect = new Worker(
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
                    workerData: { requirePath: NodePath.join(process.cwd(), "package.json"), root },
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
            NodeFS.rm(NodePath.join(root, ".codegraph-t3"), { recursive: true, force: true }),
          );

          const [concurrentStatus, concurrentSearch] = yield* Effect.all(
            [runQuery({ operation: "status" }), runQuery({ operation: "search", text: "greet" })],
            { concurrency: 2 },
          );
          assert.equal(concurrentStatus.coverage.state, "complete");
          assert.ok(concurrentSearch.matches.some((match) => match.symbol.name === "greet"));
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

          const status = yield* runQuery({ operation: "status" });
          assert.equal(status.stats?.files, 4);
          const graphDirectoryExists = yield* Effect.promise(() =>
            NodeFS.stat(NodePath.join(root, ".codegraph-t3")).then(() => true),
          );
          const standardIndexExists = yield* Effect.promise(() =>
            NodeFS.stat(NodePath.join(root, ".codegraph")).then(
              () => true,
              () => false,
            ),
          );
          const rootGitignoreExists = yield* Effect.promise(() =>
            NodeFS.stat(NodePath.join(root, ".gitignore")).then(
              () => true,
              () => false,
            ),
          );
          assert.equal(graphDirectoryExists, true);
          assert.equal(standardIndexExists, false);
          assert.equal(rootGitignoreExists, false);

          yield* Effect.promise(() =>
            NodeFS.writeFile(
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
          yield* Effect.promise(() => NodeFS.rm(NodePath.join(root, "src/main.py")));
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
            NodeFS.writeFile(
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
            await NodeFS.rm(NodePath.join(root, ".codegraph-t3"), { recursive: true, force: true });
            await NodeFS.rm(NodePath.join(worktree, ".codegraph-t3"), {
              recursive: true,
              force: true,
            });
            await NodeFS.symlink(worktree, NodePath.join(root, ".codegraph-t3"));
          });
          const indexPathError = yield* Effect.flip(runQuery({ operation: "status" }));
          assert.equal(indexPathError._tag, "CodeIntelligencePathOutsideCheckout");
          assert.equal(
            yield* Effect.promise(() =>
              NodeFS.stat(NodePath.join(worktree, ".codegraph-t3")).then(
                () => true,
                () => false,
              ),
            ),
            false,
          );
        }),
    ),
);

it.effect("recovers after SDK indexing cancellation", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const files = Array.from({ length: 250 }, (_, index) => `src/generated-${index}.py`);
      yield* Effect.promise(async () => {
        await Promise.all(
          files.map((file, index) => {
            const absolutePath = NodePath.join(fixture.root, file);
            return NodeFS.mkdir(NodePath.dirname(absolutePath), { recursive: true }).then(() =>
              NodeFS.writeFile(absolutePath, `def generated_${index}():\n    return ${index}\n`),
            );
          }),
        );
      });

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
              entries: ["src/main.py", ...files].map((path) => ({ path, kind: "file" as const })),
              truncated: false,
            }),
        }),
      );
      const provided = Layer.provide(CodeIntelligence.layer, dependencies);
      const worker = new Worker(new URL("./codeIntelligenceWorkerThread.ts", import.meta.url), {
        execArgv: ["--experimental-strip-types"],
        env: { ...process.env, CODEGRAPH_DIR: ".codegraph-t3" },
      });
      const indexingCancellation = new Promise<void>((resolve, reject) => {
        let cancellationSent = false;
        let cancellationReceived = false;
        let workerExited = false;
        const complete = () => {
          if (cancellationSent && cancellationReceived && workerExited) resolve();
        };
        worker.on(
          "message",
          (message: {
            readonly error?: string;
            readonly result?: unknown;
            readonly progress?: { readonly phase: string; readonly current: number };
          }) => {
            if (
              !cancellationSent &&
              message.progress?.phase === "parsing" &&
              message.progress.current > 0
            ) {
              cancellationSent = true;
              worker.postMessage({ type: "cancel" });
            } else if (
              cancellationSent &&
              (message.error !== undefined || message.result !== undefined)
            ) {
              cancellationReceived = true;
              complete();
            }
          },
        );
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (!cancellationSent)
            reject(new Error("SDK parsing progress was not observed before worker exit."));
          else if (code !== 0) reject(new Error(`SDK cancellation exited with code ${code}.`));
          else {
            workerExited = true;
            complete();
          }
        });
      });
      worker.postMessage({
        type: "query",
        input: {
          checkoutPath: fixture.root,
          files: ["src/main.py", ...files],
          filesListed: files.length + 1,
          listingTruncated: false,
          query: { operation: "status" },
        },
      });
      yield* Effect.promise(() => indexingCancellation);
      const query = Effect.gen(function* () {
        const intelligence = yield* CodeIntelligence.CodeIntelligence;
        return yield* intelligence.query({ projectId, query: { operation: "status" } });
      }).pipe(Effect.provide(provided));
      const recovered = yield* query;
      assert.equal(recovered.coverage.state, "complete");
      assert.ok((recovered.stats?.files ?? 0) >= files.length);
      assert.equal(recovered.coverage.relationSemantics, "static-candidates");
    }),
  ),
);
