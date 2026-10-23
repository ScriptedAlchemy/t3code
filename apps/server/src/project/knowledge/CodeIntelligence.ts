// @effect-diagnostics nodeBuiltinImport:off - this boundary owns the analysis process and its IPC.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  ProjectCodeQueryResult,
  type ProjectCodeQuery as ProjectCodeQueryType,
  type ProjectCodeQueryInput as ProjectCodeQueryInputType,
  type ProjectCodeQueryResult as ProjectCodeQueryResultType,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { isWorkspaceLeaseHeld, withWorkspaceLease } from "../../workspace/workspaceLease.ts";

const MAX_LISTED_FILES = 10_000;
const INDEX_DIRECTORY = ".codegraph-t3";

export class CodeIntelligenceProjectNotFound extends Schema.TaggedError<CodeIntelligenceProjectNotFound>()(
  "CodeIntelligenceProjectNotFound",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project ${this.projectId} is unavailable for code analysis.`;
  }
}

export class CodeIntelligenceThreadMismatch extends Schema.TaggedError<CodeIntelligenceThreadMismatch>()(
  "CodeIntelligenceThreadMismatch",
  { projectId: Schema.String, threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} does not belong to project ${this.projectId}.`;
  }
}

export class CodeIntelligencePathOutsideCheckout extends Schema.TaggedError<CodeIntelligencePathOutsideCheckout>()(
  "CodeIntelligencePathOutsideCheckout",
  { path: Schema.String },
) {
  override get message(): string {
    return `Code analysis path '${this.path}' resolves outside the checkout.`;
  }
}

export class CodeIntelligenceInspectionFailed extends Schema.TaggedError<CodeIntelligenceInspectionFailed>()(
  "CodeIntelligenceInspectionFailed",
  {
    projectId: Schema.String,
    threadId: Schema.NullOr(Schema.String),
    path: Schema.String,
    reason: Schema.Literals(["worker-failed", "invalid-result"]),
  },
) {
  override get message(): string {
    return `Code analysis failed for '${this.path}'.`;
  }
}

class CodeIntelligenceWorkerError extends Schema.TaggedError<CodeIntelligenceWorkerError>()(
  "CodeIntelligenceWorkerError",
  {
    reason: Schema.Literals([
      "worker-failed",
      "invalid-result",
      "path-outside-checkout",
      "index-outside-checkout",
    ]),
  },
) {}

export class CodeIntelligence extends Context.Service<
  CodeIntelligence,
  {
    readonly query: (
      input: ProjectCodeQueryInputType,
    ) => Effect.Effect<
      ProjectCodeQueryResultType,
      | CodeIntelligenceProjectNotFound
      | CodeIntelligenceThreadMismatch
      | CodeIntelligencePathOutsideCheckout
      | CodeIntelligenceInspectionFailed
      | ProjectStore.ProjectStoreV2Error
      | ProjectionStore.ProjectionStoreV2Error
      | WorkspacePaths.WorkspacePathsError
      | WorkspaceEntries.WorkspaceEntriesError
    >;
  }
>()("t3/project/knowledge/CodeIntelligence") {}

const WorkerReply = Schema.Union([
  Schema.Struct({ result: ProjectCodeQueryResult }),
  Schema.Struct({
    progress: Schema.Struct({
      phase: Schema.Literals(["scanning", "parsing", "storing", "resolving", "linking"]),
      current: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  }),
  Schema.Struct({ error: Schema.String }),
]);
const decodeWorkerReply = Schema.decodeUnknownSync(WorkerReply);

function normalizeQueryPaths(
  query: ProjectCodeQueryType,
  checkoutPath: string,
  workspacePaths: WorkspacePaths.WorkspacePaths["Service"],
): Effect.Effect<ProjectCodeQueryType, WorkspacePaths.WorkspacePathsError> {
  if (query.operation === "dependencies" || query.operation === "affected") {
    return workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: checkoutPath,
        relativePath: query.filePath,
      })
      .pipe(
        Effect.map(({ relativePath }) => ({
          ...query,
          filePath: relativePath,
        })),
      );
  }
  if (
    query.operation === "callers" ||
    query.operation === "callees" ||
    query.operation === "references" ||
    query.operation === "impact" ||
    query.operation === "tests"
  ) {
    if (query.symbol.filePath === undefined) return Effect.succeed(query);
    return workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: checkoutPath,
        relativePath: query.symbol.filePath,
      })
      .pipe(
        Effect.map(({ relativePath }) => ({
          ...query,
          symbol: {
            ...query.symbol,
            filePath: relativePath,
          },
        })),
      );
  }
  if (query.operation === "path") {
    const normalize = (symbol: typeof query.from) =>
      symbol.filePath === undefined
        ? Effect.succeed(symbol)
        : workspacePaths
            .resolveRelativePathWithinRoot({
              workspaceRoot: checkoutPath,
              relativePath: symbol.filePath,
            })
            .pipe(Effect.map(({ relativePath }) => ({ ...symbol, filePath: relativePath })));
    return Effect.all([normalize(query.from), normalize(query.to)]).pipe(
      Effect.map(([from, to]) => ({ ...query, from, to })),
    );
  }
  if (query.operation === "symbols" && query.filePath !== undefined) {
    return workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: checkoutPath,
        relativePath: query.filePath,
      })
      .pipe(
        Effect.map(({ relativePath }) => ({
          ...query,
          filePath: relativePath,
        })),
      );
  }
  return Effect.succeed(query);
}

interface AnalysisLaunch {
  readonly executablePath: string;
  readonly isExecutable: boolean;
}

/**
 * Analysis runs in a child process: tree-sitter's WASM grammars can abort V8 with a fatal Zone
 * OOM on Node 22+, which takes down the whole process, threads included. `--liftoff-only`
 * avoids that compiler tier, and V8 only reads it at process start (worker `execArgv` rejects
 * it). A single executable cannot take Node flags on its command line; its build bakes the
 * flag in instead.
 */
function analysisCommand(launch: AnalysisLaunch): ReadonlyArray<string> {
  if (launch.isExecutable) return ["__code-intelligence"];
  const fromSource = import.meta.url.endsWith(".ts");
  return [
    ...(fromSource ? ["--experimental-strip-types"] : []),
    "--liftoff-only",
    NodeURL.fileURLToPath(new URL(fromSource ? "../../bin.ts" : "./bin.mjs", import.meta.url)),
    "__code-intelligence",
  ];
}

function queryInAnalysisProcess(
  launch: AnalysisLaunch,
  input: {
    readonly checkoutPath: string;
    readonly files: ReadonlyArray<string>;
    readonly filesListed: number;
    readonly listingTruncated: boolean;
    readonly query: ProjectCodeQueryType;
  },
): Effect.Effect<ProjectCodeQueryResultType, CodeIntelligenceWorkerError> {
  return Effect.callback((resume) => {
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(launch.executablePath, analysisCommand(launch), {
        // ELECTRON_RUN_AS_NODE keeps the desktop's Electron binary a plain Node runtime.
        env: { ...process.env, CODEGRAPH_DIR: INDEX_DIRECTORY, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
    } catch {
      resume(Effect.fail(new CodeIntelligenceWorkerError({ reason: "worker-failed" })));
      return;
    }
    let terminal:
      | { readonly _tag: "result"; readonly value: ProjectCodeQueryResultType }
      | { readonly _tag: "error"; readonly error: CodeIntelligenceWorkerError }
      | undefined;
    let closed = false;
    let resolveClosed: (() => void) | undefined;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const fail = (error: CodeIntelligenceWorkerError, shouldKill = false) => {
      terminal ??= { _tag: "error", error };
      if (shouldKill) child.kill("SIGKILL");
    };
    child.on("message", (raw: unknown) => {
      if (terminal !== undefined) return;
      let decoded: typeof WorkerReply.Type;
      try {
        decoded = decodeWorkerReply(raw);
      } catch {
        fail(new CodeIntelligenceWorkerError({ reason: "invalid-result" }), true);
        return;
      }
      if ("progress" in decoded) return;
      if ("error" in decoded) {
        fail(
          new CodeIntelligenceWorkerError({
            reason:
              decoded.error === "path-outside-checkout" ||
              decoded.error === "index-outside-checkout"
                ? decoded.error
                : "worker-failed",
          }),
        );
      } else terminal = { _tag: "result", value: decoded.result };
    });
    child.once("error", () => {
      fail(new CodeIntelligenceWorkerError({ reason: "worker-failed" }));
    });
    // `close` follows the IPC channel closing, so every reply has been read by then.
    child.once("close", (code) => {
      closed = true;
      resolveClosed?.();
      if (terminal === undefined || code !== 0) {
        resume(
          Effect.fail(
            terminal?._tag === "error"
              ? terminal.error
              : new CodeIntelligenceWorkerError({ reason: "worker-failed" }),
          ),
        );
      } else if (terminal._tag === "error") {
        resume(Effect.fail(terminal.error));
      } else {
        resume(Effect.succeed(terminal.value));
      }
    });
    child.send({ type: "query", input }, (error) => {
      if (error !== null) fail(new CodeIntelligenceWorkerError({ reason: "worker-failed" }), true);
    });
    // The SDK's sync ignores abort signals, so only killing the process stops the indexing,
    // and the index lease is released only after it has exited.
    return Effect.promise(async () => {
      if (!closed) child.kill("SIGKILL");
      await closedPromise;
    });
  });
}

function indexingResult(checkoutPath: string): ProjectCodeQueryResultType {
  return {
    operation: "freshness",
    checkoutPath,
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
      catalogRevision: "",
      relationSemantics: "static-candidates",
      columnEncoding: "utf16-code-units",
      languages: [],
      indexedLanguages: [],
      filesListed: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      filesUnsupported: 0,
      filesFailed: 0,
      pendingReferences: 0,
      resultLimitReached: false,
      limitations: ["Another code query is indexing this checkout right now."],
    },
    index: {
      state: "indexing",
      indexedCommit: null,
      headCommit: null,
      generation: 0,
      indexedAt: null,
      changedFiles: 0,
      changedPaths: [],
    },
  };
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const launch: AnalysisLaunch = {
    executablePath: yield* HostProcess.ExecutablePath,
    isExecutable: yield* HostProcess.IsExecutable,
  };

  const query: CodeIntelligence["Service"]["query"] = Effect.fn("CodeIntelligence.query")(
    function* (input) {
      const projectOption = yield* projects.get(input.projectId);
      if (Option.isNone(projectOption) || projectOption.value.deletedAt !== null) {
        return yield* new CodeIntelligenceProjectNotFound({ projectId: input.projectId });
      }
      let registeredRoot = projectOption.value.workspaceRoot;
      if (input.threadId !== undefined) {
        const thread = yield* threads.getThread(input.threadId);
        if (thread.projectId !== input.projectId) {
          return yield* new CodeIntelligenceThreadMismatch({
            projectId: input.projectId,
            threadId: input.threadId,
          });
        }
        registeredRoot = thread.worktreePath ?? registeredRoot;
      }
      const checkoutPath = yield* workspacePaths.normalizeWorkspaceRoot(registeredRoot);
      const indexPath = NodePath.join(checkoutPath, INDEX_DIRECTORY);
      // Freshness must answer while another query holds the index, not queue behind it.
      if (input.query.operation === "freshness" && isWorkspaceLeaseHeld(indexPath)) {
        return indexingResult(checkoutPath);
      }
      const normalizedQuery = yield* normalizeQueryPaths(input.query, checkoutPath, workspacePaths);
      yield* workspaceEntries.refresh(checkoutPath);
      const workspaceListing = yield* workspaceEntries.list({ cwd: checkoutPath });
      const listedFiles = workspaceListing.entries
        // The index writes its own directory into the checkout; counting it would report the
        // graph's files as unsupported source.
        .filter(
          (entry) =>
            entry.kind === "file" &&
            entry.ignored !== true &&
            entry.path !== INDEX_DIRECTORY &&
            !entry.path.startsWith(`${INDEX_DIRECTORY}/`),
        )
        .map((entry) => entry.path);
      return yield* withWorkspaceLease(
        indexPath,
        queryInAnalysisProcess(launch, {
          checkoutPath,
          files: listedFiles.slice(0, MAX_LISTED_FILES),
          filesListed: listedFiles.length,
          listingTruncated: workspaceListing.truncated || listedFiles.length > MAX_LISTED_FILES,
          query: normalizedQuery,
        }).pipe(
          Effect.mapError((cause) => {
            const queryPath =
              normalizedQuery.operation === "dependencies" ||
              normalizedQuery.operation === "affected" ||
              normalizedQuery.operation === "symbols"
                ? normalizedQuery.filePath
                : normalizedQuery.operation === "callers" ||
                    normalizedQuery.operation === "callees" ||
                    normalizedQuery.operation === "references" ||
                    normalizedQuery.operation === "impact" ||
                    normalizedQuery.operation === "tests"
                  ? normalizedQuery.symbol.filePath
                  : normalizedQuery.operation === "path"
                    ? (normalizedQuery.from.filePath ?? normalizedQuery.to.filePath)
                    : undefined;
            if (cause.reason === "path-outside-checkout" && queryPath !== undefined) {
              return new CodeIntelligencePathOutsideCheckout({ path: queryPath });
            }
            if (cause.reason === "index-outside-checkout") {
              return new CodeIntelligencePathOutsideCheckout({ path: INDEX_DIRECTORY });
            }
            return new CodeIntelligenceInspectionFailed({
              projectId: input.projectId,
              threadId: input.threadId ?? null,
              path:
                queryPath ??
                (normalizedQuery.operation === "symbols"
                  ? (normalizedQuery.name ?? checkoutPath)
                  : normalizedQuery.operation === "search"
                    ? normalizedQuery.text
                    : checkoutPath),
              reason: cause.reason === "invalid-result" ? "invalid-result" : "worker-failed",
            });
          }),
        ),
      );
    },
  );

  return CodeIntelligence.of({ query });
});

export const layer = Layer.effect(CodeIntelligence, make);
