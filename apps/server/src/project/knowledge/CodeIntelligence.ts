// @effect-diagnostics nodeBuiltinImport:off - this boundary owns worker paths and isolated SDK loading.
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";

import {
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

function queryWithWorker(input: {
  readonly checkoutPath: string;
  readonly files: ReadonlyArray<string>;
  readonly filesListed: number;
  readonly listingTruncated: boolean;
  readonly query: ProjectCodeQueryType;
}): Effect.Effect<ProjectCodeQueryResultType, CodeIntelligenceWorkerError> {
  const fromSource = import.meta.url.endsWith(".ts");
  const workerUrl = new URL(
    fromSource
      ? "./codeIntelligenceWorkerThread.ts"
      : "./project/knowledge/codeIntelligenceWorkerThread.mjs",
    import.meta.url,
  );
  return Effect.callback((resume) => {
    let worker: NodeWorkerThreads.Worker;
    try {
      worker = new NodeWorkerThreads.Worker(workerUrl, {
        ...(fromSource ? { execArgv: ["--experimental-strip-types"] } : {}),
        env: { ...process.env, CODEGRAPH_DIR: INDEX_DIRECTORY },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_LIMIT_MB },
      });
    } catch {
      resume(Effect.fail(new CodeIntelligenceWorkerError({ reason: "worker-failed" })));
      return;
    }
    let terminal:
      | { readonly _tag: "result"; readonly value: ProjectCodeQueryResultType }
      | { readonly _tag: "error"; readonly error: CodeIntelligenceWorkerError }
      | undefined;
    let exited = false;
    let resolveExit: (() => void) | undefined;
    const exit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const terminate = () => {
      void worker.terminate().catch(() => {
        fail(new CodeIntelligenceWorkerError({ reason: "worker-failed" }));
      });
    };
    const fail = (error: CodeIntelligenceWorkerError, shouldTerminate = false) => {
      terminal ??= { _tag: "error", error };
      if (shouldTerminate) terminate();
    };
    worker.on("message", (raw: unknown) => {
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
    worker.once("error", () => {
      fail(new CodeIntelligenceWorkerError({ reason: "worker-failed" }));
    });
    worker.once("exit", (code) => {
      exited = true;
      resolveExit?.();
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
    try {
      worker.postMessage({ type: "query", input });
    } catch {
      fail(new CodeIntelligenceWorkerError({ reason: "worker-failed" }), true);
    }
    return Effect.promise(async () => {
      if (!exited) {
        try {
          worker.postMessage({ type: "cancel" });
        } catch {
          await worker.terminate();
        }
      }
      await exit;
    });
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
        NodePath.join(checkoutPath, INDEX_DIRECTORY),
        queryWithWorker({
          checkoutPath,
          files: listedFiles.slice(0, MAX_LISTED_FILES),
          filesListed: listedFiles.length,
          listingTruncated: workspaceListing.truncated || listedFiles.length > MAX_LISTED_FILES,
          query: normalizedQuery,
        }).pipe(
          Effect.mapError((cause) => {
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
                  ? normalizedQuery.name
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
