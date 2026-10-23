// @effect-diagnostics nodeBuiltinImport:off - this boundary owns the analysis process, its IPC, and the index generation directories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import {
  INDEX_DIRECTORY,
  IndexOutsideCheckout,
  generationDirectory,
  isIndexPath,
  listGenerations,
  publishGeneration,
  readPublishedGeneration,
  removeLegacyIndexFiles,
} from "./codeIndexLayout.ts";
import type { CodeIntelligenceCommand } from "./codeIntelligenceWorkerThread.ts";

const MAX_LISTED_FILES = 10_000;

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

type CodeIndexTarget = Pick<ProjectCodeQueryInputType, "projectId" | "threadId">;

type CheckoutLookupError =
  | CodeIntelligenceProjectNotFound
  | CodeIntelligenceThreadMismatch
  | ProjectStore.ProjectStoreV2Error
  | ProjectionStore.ProjectionStoreV2Error
  | WorkspacePaths.WorkspacePathsError;

/** How one build of a checkout's index ended. */
export type CodeIndexRefreshOutcome =
  | { readonly _tag: "Published"; readonly generation: number }
  // The published generation already matches the checkout, or there is none to refresh.
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Failed"; readonly reason: CodeIntelligenceWorkerError["reason"] | "listing" };

export class CodeIntelligence extends Context.Service<
  CodeIntelligence,
  {
    /** Answers from the published index generation and never waits for a build. */
    readonly query: (
      input: ProjectCodeQueryInputType,
    ) => Effect.Effect<
      ProjectCodeQueryResultType,
      | CheckoutLookupError
      | CodeIntelligencePathOutsideCheckout
      | CodeIntelligenceInspectionFailed
      | WorkspaceEntries.WorkspaceEntriesError
    >;
    /** Builds a successor generation, coalesced per checkout, and waits for the outcome. */
    readonly refresh: (
      input: CodeIndexTarget,
    ) => Effect.Effect<CodeIndexRefreshOutcome, CheckoutLookupError>;
  }
>()("t3/project/knowledge/CodeIntelligence") {}

const WorkerReply = Schema.Union([
  Schema.Struct({ result: ProjectCodeQueryResult }),
  Schema.Struct({ built: Schema.Struct({ changed: Schema.Boolean }) }),
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
type WorkerTerminal = Exclude<typeof WorkerReply.Type, { readonly progress: unknown }>;

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

/**
 * A server run under `node --watch` exports WATCH_REPORT_DEPENDENCIES, which makes any Node
 * child report its imports over its IPC channel; on the analysis channel those reports would
 * read as malformed replies.
 */
function analysisEnvironment(): NodeJS.ProcessEnv {
  const { WATCH_REPORT_DEPENDENCIES: _watchReport, ...environment } = process.env;
  // ELECTRON_RUN_AS_NODE keeps the desktop's Electron binary a plain Node runtime. The worker
  // selects each generation itself; the control directory is a default that holds no index.
  return { ...environment, CODEGRAPH_DIR: INDEX_DIRECTORY, ELECTRON_RUN_AS_NODE: "1" };
}

function runInAnalysisProcess(
  launch: AnalysisLaunch,
  command: CodeIntelligenceCommand,
): Effect.Effect<WorkerTerminal, CodeIntelligenceWorkerError> {
  return Effect.callback((resume) => {
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(launch.executablePath, analysisCommand(launch), {
        env: analysisEnvironment(),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
    } catch {
      resume(Effect.fail(new CodeIntelligenceWorkerError({ reason: "worker-failed" })));
      return;
    }
    let terminal:
      | { readonly _tag: "reply"; readonly value: WorkerTerminal }
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
      } else terminal = { _tag: "reply", value: decoded };
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
    child.send(command, (error) => {
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

/** One checkout's builds: the one running and the one queued behind it. */
interface CheckoutBuilds {
  // Covers every request made before it started.
  running: Deferred.Deferred<CodeIndexRefreshOutcome> | null;
  // Covers requests made while `running` was in flight, which it may have read past.
  queued: Deferred.Deferred<CodeIndexRefreshOutcome> | null;
}

const removeGeneration = (checkoutPath: string, generation: number) =>
  Effect.promise(() =>
    // `rm` unlinks a planted link instead of following it.
    NodeFSP.rm(NodePath.join(checkoutPath, generationDirectory(generation)), {
      recursive: true,
      force: true,
    }).catch(() => undefined),
  );

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const launch: AnalysisLaunch = {
    executablePath: yield* HostProcess.ExecutablePath,
    isExecutable: yield* HostProcess.IsExecutable,
  };
  const serviceScope = yield* Effect.scope;
  const builds = new Map<string, CheckoutBuilds>();

  const resolveCheckout = Effect.fn("CodeIntelligence.resolveCheckout")(function* (
    input: CodeIndexTarget,
  ) {
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
    return yield* workspacePaths.normalizeWorkspaceRoot(registeredRoot);
  });

  const listCheckout = Effect.fn("CodeIntelligence.listCheckout")(function* (checkoutPath: string) {
    yield* workspaceEntries.refresh(checkoutPath);
    const listing = yield* workspaceEntries.list({ cwd: checkoutPath });
    const files = listing.entries
      // The index lives in the checkout; counting it would report its files as unsupported
      // source.
      .filter(
        (entry) => entry.kind === "file" && entry.ignored !== true && !isIndexPath(entry.path),
      )
      .map((entry) => entry.path);
    return {
      checkoutPath,
      files: files.slice(0, MAX_LISTED_FILES),
      filesListed: files.length,
      listingTruncated: listing.truncated || files.length > MAX_LISTED_FILES,
    };
  });

  const buildGeneration = Effect.fn("CodeIntelligence.buildGeneration")(function* (
    checkoutPath: string,
  ): Effect.fn.Return<
    CodeIndexRefreshOutcome,
    CodeIntelligenceWorkerError | WorkspaceEntries.WorkspaceEntriesError
  > {
    const plan = yield* Effect.try({
      try: () => {
        const published = readPublishedGeneration(checkoutPath);
        removeLegacyIndexFiles(checkoutPath);
        return { published, existing: listGenerations(checkoutPath) };
      },
      catch: (cause) =>
        new CodeIntelligenceWorkerError({
          reason:
            cause instanceof IndexOutsideCheckout ? "index-outside-checkout" : "worker-failed",
        }),
    });
    const generation = Math.max(plan.published ?? 0, ...plan.existing) + 1;
    const listing = yield* listCheckout(checkoutPath);
    const reply = yield* runInAnalysisProcess(launch, {
      type: "build",
      input: {
        ...listing,
        from: plan.published === null ? null : generationDirectory(plan.published),
        to: generationDirectory(generation),
        generation,
      },
    }).pipe(Effect.onError(() => removeGeneration(checkoutPath, generation)));
    if (!("built" in reply)) {
      yield* removeGeneration(checkoutPath, generation);
      return yield* new CodeIntelligenceWorkerError({ reason: "invalid-result" });
    }
    if (!reply.built.changed) return { _tag: "Unchanged" } as const;
    yield* Effect.try({
      try: () => publishGeneration(checkoutPath, generation),
      catch: (cause) =>
        new CodeIntelligenceWorkerError({
          reason:
            cause instanceof IndexOutsideCheckout ? "index-outside-checkout" : "worker-failed",
        }),
    }).pipe(Effect.onError(() => removeGeneration(checkoutPath, generation)));
    return { _tag: "Published", generation } as const;
  });

  const buildOnce = (checkoutPath: string): Effect.Effect<CodeIndexRefreshOutcome> =>
    // The lease serializes this checkout's builders across every instance in the process.
    withWorkspaceLease(
      NodePath.join(checkoutPath, INDEX_DIRECTORY),
      buildGeneration(checkoutPath),
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          _tag: "Failed",
          reason: error._tag === "CodeIntelligenceWorkerError" ? error.reason : "listing",
        } as const),
      ),
      Effect.tap((outcome) =>
        outcome._tag === "Failed"
          ? Effect.logWarning("Code index build failed", { checkoutPath, reason: outcome.reason })
          : Effect.void,
      ),
    );

  const runBuilds = Effect.fn("CodeIntelligence.runBuilds")(
    function* (checkoutPath: string, state: CheckoutBuilds) {
      let current = state.running;
      while (current !== null) {
        const outcome = yield* buildOnce(checkoutPath);
        yield* Deferred.succeed(current, outcome);
        // Promoting and reading the next build in one step keeps a concurrent request from
        // starting a second loop for the same checkout.
        current = yield* Effect.sync(() => {
          state.running = state.queued;
          state.queued = null;
          return state.running;
        });
      }
    },
    (effect, _checkoutPath, state) =>
      effect.pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            const pending = [state.running, state.queued];
            state.running = null;
            state.queued = null;
            for (const deferred of pending)
              if (deferred !== null) yield* Deferred.interrupt(deferred);
          }),
        ),
      ),
  );

  /** The build that will cover a request made now; starts one when the checkout is idle. */
  const requestBuild = (checkoutPath: string) =>
    Effect.suspend(() => {
      const state = builds.get(checkoutPath) ?? { running: null, queued: null };
      builds.set(checkoutPath, state);
      if (state.queued !== null) return Effect.succeed(state.queued);
      const next = Deferred.makeUnsafe<CodeIndexRefreshOutcome>();
      if (state.running !== null) {
        state.queued = next;
        return Effect.succeed(next);
      }
      state.running = next;
      return runBuilds(checkoutPath, state).pipe(Effect.forkIn(serviceScope), Effect.as(next));
    });

  const refresh: CodeIntelligence["Service"]["refresh"] = Effect.fn("CodeIntelligence.refresh")(
    function* (input) {
      const checkoutPath = yield* resolveCheckout(input);
      return yield* Deferred.await(yield* requestBuild(checkoutPath));
    },
  );

  const query: CodeIntelligence["Service"]["query"] = Effect.fn("CodeIntelligence.query")(
    function* (input) {
      const checkoutPath = yield* resolveCheckout(input);
      const normalizedQuery = yield* normalizeQueryPaths(input.query, checkoutPath, workspacePaths);
      const published = yield* Effect.try({
        try: () => readPublishedGeneration(checkoutPath),
        catch: (cause) =>
          cause instanceof IndexOutsideCheckout
            ? new CodeIntelligencePathOutsideCheckout({ path: INDEX_DIRECTORY })
            : new CodeIntelligenceInspectionFailed({
                projectId: input.projectId,
                threadId: input.threadId ?? null,
                path: INDEX_DIRECTORY,
                reason: "worker-failed",
              }),
      });
      // A query converges the index on the checkout without waiting for it; freshness only
      // observes.
      if (normalizedQuery.operation !== "freshness") yield* requestBuild(checkoutPath);
      const listing = yield* listCheckout(checkoutPath);
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
      const toQueryError = (reason: CodeIntelligenceWorkerError["reason"]) => {
        if (reason === "path-outside-checkout" && queryPath !== undefined) {
          return new CodeIntelligencePathOutsideCheckout({ path: queryPath });
        }
        if (reason === "index-outside-checkout") {
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
          reason: reason === "invalid-result" ? "invalid-result" : "worker-failed",
        });
      };
      const reply = yield* runInAnalysisProcess(launch, {
        type: "query",
        input: {
          ...listing,
          query: normalizedQuery,
          indexDirectory: published === null ? null : generationDirectory(published),
        },
      }).pipe(Effect.mapError((cause) => toQueryError(cause.reason)));
      if (!("result" in reply)) return yield* toQueryError("invalid-result");
      return reply.result;
    },
  );

  return CodeIntelligence.of({ query, refresh });
});

export const layer = Layer.effect(CodeIntelligence, make);
