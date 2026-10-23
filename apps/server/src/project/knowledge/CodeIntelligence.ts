// @effect-diagnostics nodeBuiltinImport:off - this boundary owns worker paths and isolated SDK loading.
import { Worker } from "node:worker_threads";

import {
  ProjectCodeQueryInput,
  ProjectCodeQueryResult,
  type ProjectCodeQuery as ProjectCodeQueryType,
  type ProjectCodeQueryInput as ProjectCodeQueryInputType,
  type ProjectCodeQueryResult as ProjectCodeQueryResultType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";

const WORKER_MEMORY_LIMIT_MB = 768;
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

function normalizeQueryPaths(
  query: ProjectCodeQueryType,
  checkoutPath: string,
  workspacePaths: WorkspacePaths.WorkspacePaths["Service"],
): Effect.Effect<ProjectCodeQueryType, WorkspacePaths.WorkspacePathsError> {
  if (query.operation === "dependencies") {
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
    query.operation === "impact"
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

function queryWithWorker(
  input: {
    readonly checkoutPath: string;
    readonly files: ReadonlyArray<string>;
    readonly filesListed: number;
    readonly listingTruncated: boolean;
    readonly query: ProjectCodeQueryType;
  },
  signal: AbortSignal,
): Promise<ProjectCodeQueryResultType> {
  const fromSource = import.meta.url.endsWith(".ts");
  const workerUrl = new URL(
    fromSource
      ? "./codeIntelligenceWorkerThread.ts"
      : "./project/knowledge/codeIntelligenceWorkerThread.mjs",
    import.meta.url,
  );
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      ...(fromSource ? { execArgv: ["--experimental-strip-types"] } : {}),
      env: { ...process.env, CODEGRAPH_DIR: INDEX_DIRECTORY },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_LIMIT_MB },
    });
    let settled = false;
    let abortReason: unknown;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      void worker.terminate().catch(() => undefined);
      action();
    };
    const onAbort = () => {
      if (settled) return;
      abortReason = signal.reason;
      try {
        worker.postMessage({ type: "cancel" });
      } catch {
        finish(() => reject(abortReason));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (raw: unknown) => {
      if (settled) return;
      let decoded: typeof WorkerReply.Type;
      try {
        decoded = Schema.decodeUnknownSync(WorkerReply)(raw);
      } catch {
        finish(() => reject(new Error("invalid-result")));
        return;
      }
      if ("progress" in decoded) return;
      if ("error" in decoded) {
        finish(() => reject(abortReason ?? new Error(decoded.error)));
        return;
      }
      finish(() => (abortReason === undefined ? resolve(decoded.result) : reject(abortReason)));
    });
    worker.once("error", (cause) => finish(() => reject(cause)));
    worker.once("exit", (code) => {
      if (code !== 0 || !settled) finish(() => reject(new Error("worker-failed")));
    });
    worker.postMessage({ type: "query", input });
    if (signal.aborted) onAbort();
  });
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

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
      const normalizedQuery = yield* normalizeQueryPaths(input.query, checkoutPath, workspacePaths);
      yield* workspaceEntries.refresh(checkoutPath);
      const workspaceListing = yield* workspaceEntries.list({ cwd: checkoutPath });
      const listedFiles = workspaceListing.entries
        .filter((entry) => entry.kind === "file" && entry.ignored !== true)
        .map((entry) => entry.path);
      return yield* withWorkspaceLease(
        checkoutPath,
        Effect.tryPromise({
          try: (signal) =>
            queryWithWorker(
              {
                checkoutPath,
                files: listedFiles.slice(0, MAX_LISTED_FILES),
                filesListed: listedFiles.length,
                listingTruncated:
                  workspaceListing.truncated || listedFiles.length > MAX_LISTED_FILES,
                query: normalizedQuery,
              },
              signal,
            ),
          catch: (cause) => {
            const queryPath =
              normalizedQuery.operation === "dependencies"
                ? normalizedQuery.filePath
                : normalizedQuery.operation === "callers" ||
                    normalizedQuery.operation === "callees" ||
                    normalizedQuery.operation === "references" ||
                    normalizedQuery.operation === "impact"
                  ? normalizedQuery.symbol.filePath
                  : normalizedQuery.operation === "symbols"
                    ? normalizedQuery.filePath
                    : undefined;
            if (
              cause instanceof Error &&
              cause.message === "path-outside-checkout" &&
              queryPath !== undefined
            ) {
              return new CodeIntelligencePathOutsideCheckout({ path: queryPath });
            }
            if (cause instanceof Error && cause.message === "index-outside-checkout") {
              return new CodeIntelligencePathOutsideCheckout({ path: INDEX_DIRECTORY });
            }
            return new CodeIntelligenceInspectionFailed({
              projectId: input.projectId,
              threadId: input.threadId ?? null,
              path:
                queryPath ??
                (normalizedQuery.operation === "symbols"
                  ? normalizedQuery.name
                  : normalizedQuery.operation === "search"
                    ? normalizedQuery.text
                    : checkoutPath),
              reason:
                cause instanceof Error && cause.message === "invalid-result"
                  ? "invalid-result"
                  : "worker-failed",
            });
          },
        }),
      );
    },
  );

  return CodeIntelligence.of({ query });
});

export const layer = Layer.effect(CodeIntelligence, make);
