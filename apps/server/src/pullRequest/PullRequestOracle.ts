import {
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type PullRequestFailureReport,
  type PullRequestFeedbackReport,
  type PullRequestRateLimited,
  type PullRequestReadTarget,
  type PullRequestReadUnavailable,
  type PullRequestRef,
  type PullRequestResolvedVia,
  type PullRequestStatusEntry,
  type PullRequestStatusReport,
  PullRequestUnavailableError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import {
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "../sourceControl/threadPullRequests.ts";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";
import {
  feedbackOf,
  type ForgeWords,
  isoOf,
  rateLimitedOf,
  selectCheckFailures,
  statusEntryOf,
} from "./pullRequestReports.ts";
import {
  locatePullRequestTargets,
  projectForPullRequest,
  PullRequestProjectNotFoundError,
  type PullRequestTargetError,
} from "./pullRequestTargets.ts";

export class PullRequestOracleNoTargetError extends Schema.TaggedError<PullRequestOracleNoTargetError>()(
  "PullRequestOracleNoTargetError",
  {},
) {
  override get message(): string {
    return "No pull request is linked to this thread or its parent, and T3 knows none for this branch. Name one: pass url, or repository and number.";
  }
}

export class PullRequestOracleAmbiguousTargetError extends Schema.TaggedError<PullRequestOracleAmbiguousTargetError>()(
  "PullRequestOracleAmbiguousTargetError",
  { urls: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `This thread has several pull requests. Name one by url: ${this.urls.join(", ")}.`;
  }
}

export type PullRequestOracleError =
  | PullRequestOracleNoTargetError
  | PullRequestOracleAmbiguousTargetError
  | PullRequestTargetError
  | PullRequestProjectNotFoundError
  | PullRequestService.PullRequestError;

/** Native subagents share their parent's MCP token, so they ask as the parent thread. */
export interface PullRequestOracleCaller {
  readonly threadId: ThreadId | null;
}

export interface PullRequestOracleReadInput {
  readonly caller: PullRequestOracleCaller;
  /** Omitted means the pull requests the calling thread is working on. */
  readonly pullRequests?: ReadonlyArray<PullRequestReadTarget> | undefined;
}

/**
 * Agents' pull request reads. Every answer composes `PullRequestService` reads the UI and the
 * reactors already share; the caller's thread supplies the target when none is named.
 */
export class PullRequestOracle extends Context.Service<
  PullRequestOracle,
  {
    readonly status: (
      input: PullRequestOracleReadInput,
    ) => Effect.Effect<PullRequestStatusReport, PullRequestOracleError>;
    readonly failures: (
      input: PullRequestOracleReadInput & { readonly checks?: ReadonlyArray<string> | undefined },
    ) => Effect.Effect<PullRequestFailureReport | PullRequestRateLimited, PullRequestOracleError>;
    readonly feedback: (
      input: PullRequestOracleReadInput,
    ) => Effect.Effect<PullRequestFeedbackReport | PullRequestRateLimited, PullRequestOracleError>;
  }
>()("t3/pullRequest/PullRequestOracle") {}

interface Located {
  readonly url: string;
  readonly number: number;
  readonly ref: PullRequestRef;
  readonly resolvedVia: PullRequestResolvedVia;
  readonly forge: ForgeWords;
}

interface Unlocated {
  readonly url: string | undefined;
  readonly number: number | undefined;
  readonly error: PullRequestTargetError | PullRequestProjectNotFoundError;
}

const forgeWordsOf = (project: OrchestrationProjectShell): ForgeWords => {
  const kind = project.repositoryIdentity?.provider;
  const definition = kind === undefined ? undefined : sourceControlDefinitions.get(kind);
  return {
    label: definition?.label ?? "This host",
    cli: definition?.credentials?.cliName ?? "host CLI",
  };
};

const openLinks = (thread: OrchestrationV2ThreadShell) =>
  visibleThreadPullRequests(threadPullRequestsOf(thread)).filter(
    (link) => link.snapshot?.state !== "merged" && link.snapshot?.state !== "closed",
  );

const unavailable = (target: Unlocated): PullRequestReadUnavailable => ({
  _tag: "Unavailable",
  ...(target.url === undefined ? {} : { url: target.url }),
  ...(target.number === undefined ? {} : { number: target.number }),
  message: target.error.message,
});

const make = Effect.gen(function* () {
  const service = yield* PullRequestService.PullRequestService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* PullRequestProviderRegistry.PullRequestProviderRegistry;

  const threadOf = (threadId: ThreadId | null) =>
    threadId === null
      ? Effect.succeed(null)
      : engine.getThreadShell(threadId).pipe(
          Effect.orDie,
          Effect.map((shell) => (shell?.deletedAt === null ? shell : null)),
        );

  const callerContext = Effect.fn("PullRequestOracle.callerContext")(function* (
    caller: PullRequestOracleCaller,
  ) {
    const thread = yield* threadOf(caller.threadId);
    const known = yield* projects
      .listShells({ resolveRepositoryIdentity: true })
      .pipe(Effect.orDie);
    const callerProject = known.find((project) => project.id === thread?.projectId);
    return { thread, known, callerProject };
  });

  const located = (
    context: {
      readonly known: ReadonlyArray<OrchestrationProjectShell>;
      readonly callerProject: OrchestrationProjectShell | undefined;
    },
    target: {
      readonly host: string;
      readonly repository: string;
      readonly number: number;
      readonly url: string;
    },
    resolvedVia: PullRequestResolvedVia,
  ): Located | Unlocated => {
    const publicHost = sourceControlDefinitions.findByPublicHost(target.host);
    const callerIdentity = context.callerProject?.repositoryIdentity;
    const canReadFromCaller =
      publicHost !== undefined &&
      providers.get(publicHost.kind)?.readsPublicHostWithoutCheckout === true &&
      callerIdentity != null &&
      sourceControlDefinitions.changeRequestHost(callerIdentity, callerIdentity.provider) ===
        target.host;
    const project =
      projectForPullRequest(context.known, target, context.callerProject) ??
      (canReadFromCaller ? context.callerProject : undefined);
    if (project === undefined) {
      return {
        url: target.url,
        number: target.number,
        error: new PullRequestProjectNotFoundError({ repository: target.repository }),
      };
    }
    return {
      url: target.url,
      number: target.number,
      ref: {
        projectId: project.id,
        host: target.host,
        repository: target.repository,
        number: target.number,
      },
      resolvedVia,
      forge: forgeWordsOf(project),
    };
  };

  /** The caller's open links, else its parent's for a child, else the branch's pull request. */
  const defaultTargets = Effect.fn("PullRequestOracle.defaultTargets")(function* (
    caller: PullRequestOracleCaller,
  ): Effect.fn.Return<ReadonlyArray<Located | Unlocated>, PullRequestOracleNoTargetError> {
    const context = yield* callerContext(caller);
    const { thread, callerProject } = context;
    if (thread === null) return yield* new PullRequestOracleNoTargetError();
    const own = openLinks(thread);
    if (own.length > 0) return own.map((link) => located(context, link, "linked"));
    if (thread.lineage.relationshipToParent === "subagent" && thread.lineage.parentThreadId) {
      const parent = yield* threadOf(thread.lineage.parentThreadId);
      const inherited = parent === null ? [] : openLinks(parent);
      if (inherited.length > 0)
        return inherited.map((link) => located(context, link, "parent-linked"));
    }
    const branch = thread.branchPullRequest;
    if (branch != null && callerProject !== undefined) {
      return [
        {
          url: branch.url,
          number: branch.number,
          ref: {
            projectId: branch.projectId,
            repository: branch.repository,
            number: branch.number,
          },
          resolvedVia: "branch",
          forge: forgeWordsOf(callerProject),
        },
      ];
    }
    return yield* new PullRequestOracleNoTargetError();
  });

  const namedTargets = Effect.fn("PullRequestOracle.namedTargets")(function* (
    caller: PullRequestOracleCaller,
    targets: ReadonlyArray<PullRequestReadTarget>,
  ) {
    const context = yield* callerContext(caller);
    const entries = yield* locatePullRequestTargets(targets, context.known, context.callerProject);
    return entries.map((entry): Located | Unlocated =>
      entry.target === null
        ? { url: entry.input.url, number: entry.input.number, error: entry.failure }
        : located(context, entry.target, "named"),
    );
  });

  const targetsOf = (input: PullRequestOracleReadInput) =>
    input.pullRequests === undefined
      ? defaultTargets(input.caller)
      : namedTargets(input.caller, input.pullRequests);

  /** One pull request: the only default, or the one named, with typed failures. */
  const single = Effect.fn("PullRequestOracle.single")(function* (
    input: PullRequestOracleReadInput,
  ) {
    const targets = yield* targetsOf(input);
    if (targets.length > 1) {
      return yield* new PullRequestOracleAmbiguousTargetError({
        urls: targets.flatMap((target) => (target.url === undefined ? [] : [target.url])),
      });
    }
    const target = targets[0];
    if (target === undefined) return yield* new PullRequestOracleNoTargetError();
    return "error" in target ? yield* target.error : target;
  });

  const readStatus = Effect.fn("PullRequestOracle.readStatus")(function* (
    target: Located,
  ): Effect.fn.Return<
    PullRequestStatusEntry | PullRequestReadUnavailable | PullRequestRateLimited
  > {
    const [summary, checks] = yield* Effect.all(
      [
        service.summary(target.ref).pipe(Effect.result),
        service.checks(target.ref).pipe(Effect.result),
      ],
      { concurrency: 2 },
    );
    const now = yield* Clock.currentTimeMillis;
    if (Result.isFailure(summary)) {
      return (
        rateLimitedOf(summary.failure, target.forge, now) ?? {
          _tag: "Unavailable",
          url: target.url,
          number: target.number,
          message: summary.failure.message,
        }
      );
    }
    if (Result.isFailure(checks)) {
      const paused = rateLimitedOf(checks.failure, target.forge, now);
      if (paused !== null) return paused;
    }
    return statusEntryOf({
      url: target.url,
      resolvedVia: target.resolvedVia,
      summary: summary.success,
      // A host without a checks read still has a summary to report.
      checks: Result.isSuccess(checks) ? checks.success : null,
    });
  });

  const status: PullRequestOracle["Service"]["status"] = Effect.fn("PullRequestOracle.status")(
    function* (input) {
      const pullRequests = yield* Effect.forEach(
        yield* targetsOf(input),
        (target) => ("error" in target ? Effect.succeed(unavailable(target)) : readStatus(target)),
        // The summary batch width, so one GraphQL request serves the whole list.
        { concurrency: 25 },
      );
      return { pullRequests };
    },
  );

  const failures: PullRequestOracle["Service"]["failures"] = Effect.fn(
    "PullRequestOracle.failures",
  )(function* (input) {
    const target = yield* single(input);
    const checks = yield* service.checks(target.ref).pipe(Effect.result);
    if (Result.isFailure(checks)) {
      return (
        rateLimitedOf(checks.failure, target.forge, yield* Clock.currentTimeMillis) ??
        (yield* checks.failure)
      );
    }
    if (checks.success === null) {
      return yield* new PullRequestUnavailableError({ reason: "provider-unsupported" });
    }
    const { chosen, omitted } = selectCheckFailures(checks.success.checks, input.checks);
    const reads = yield* Effect.forEach(
      chosen,
      (check) =>
        service.checkFailures({ ...target.ref, handle: check.handle }).pipe(
          Effect.result,
          Effect.map((result) => ({ check, result })),
        ),
      { concurrency: 3 },
    );
    const now = yield* Clock.currentTimeMillis;
    const failed: Array<PullRequestFailureReport["omitted"][number]> = [];
    for (const { check, result } of reads) {
      if (Result.isSuccess(result)) continue;
      const paused = rateLimitedOf(result.failure, target.forge, now);
      if (paused !== null) return paused;
      failed.push({
        name: check.name,
        status: check.status,
        url: check.url,
        reason: "read-failed",
      });
    }
    return {
      _tag: "Failures" as const,
      url: target.url,
      number: target.number,
      ...(checks.success.headSha === undefined ? {} : { headSha: checks.success.headSha }),
      ...(checks.success.observedAt === undefined
        ? {}
        : { observedAt: isoOf(checks.success.observedAt) }),
      failures: reads.flatMap(({ result }) => (Result.isSuccess(result) ? [result.success] : [])),
      omitted: [...omitted, ...failed],
    };
  });

  const feedback: PullRequestOracle["Service"]["feedback"] = Effect.fn(
    "PullRequestOracle.feedback",
  )(function* (input) {
    const target = yield* single(input);
    const read = yield* Effect.all([service.summary(target.ref), service.activity(target.ref)], {
      concurrency: 2,
    }).pipe(Effect.result);
    if (Result.isFailure(read)) {
      return (
        rateLimitedOf(read.failure, target.forge, yield* Clock.currentTimeMillis) ??
        (yield* read.failure)
      );
    }
    const [summary, activity] = read.success;
    return feedbackOf({ url: target.url, summary, activity });
  });

  return PullRequestOracle.of({ status, failures, feedback });
});

export const layer = Layer.effect(PullRequestOracle, make);
