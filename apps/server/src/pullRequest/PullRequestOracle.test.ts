import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type PullRequestCheck,
  type PullRequestCheckFailure,
  type PullRequestChecks,
  PullRequestOperationError,
  type PullRequestRef,
  type PullRequestSummary,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import { fakePullRequestProvider } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestOracle from "./PullRequestOracle.ts";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";

const PROJECT_ID = ProjectId.make("project-1");
const OTHER_PROJECT_ID = ProjectId.make("project-2");
const THREAD_ID = ThreadId.make("thread-1");
const PARENT_ID = ThreadId.make("thread-parent");
const RETRY_AT = Date.UTC(2026, 9, 30, 20, 5);

const project = (id: ProjectId, owner: string, name: string): OrchestrationProjectShell => ({
  id,
  title: `${owner}/${name}`,
  workspaceRoot: `/workspace/${name}`,
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: {
    canonicalKey: `github.com/${owner}/${name}`.toLowerCase(),
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `git@github.com:${owner}/${name}.git`,
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: `${owner}/${name}`,
    owner,
    name,
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

const PROJECTS = [project(PROJECT_ID, "acme", "app"), project(OTHER_PROJECT_ID, "acme", "docs")];

const link = (
  number: number,
  overrides: Partial<ThreadPullRequestLink> & { readonly state?: PullRequestSummary["state"] } = {},
): ThreadPullRequestLink => {
  const { state, ...rest } = overrides;
  return {
    host: "github.com",
    repository: rest.repository ?? "acme/app",
    number,
    url: `https://github.com/${rest.repository ?? "acme/app"}/pull/${number}`,
    source: "agent",
    linkedAt: "2026-10-30T00:00:00.000Z",
    snapshot:
      state === undefined
        ? null
        : {
            state,
            title: `PR ${number}`,
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-10-30T00:00:00.000Z",
          },
    stack: null,
    ...rest,
  };
};

const thread = (
  id: ThreadId,
  overrides: {
    readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink>;
    readonly lineage?: OrchestrationV2ThreadShell["lineage"];
    readonly branchPullRequest?: OrchestrationV2ThreadShell["branchPullRequest"];
  } = {},
): OrchestrationV2ThreadShell =>
  v2PullRequestThread({
    id,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: "claudeAgent" as never, model: "claude-haiku-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: null,
    pullRequests: overrides.pullRequests ?? [],
    branchPullRequest: overrides.branchPullRequest ?? null,
    ...(overrides.lineage === undefined ? {} : { lineage: overrides.lineage }),
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: null,
  });

const childLineage = {
  rootThreadId: PARENT_ID,
  parentThreadId: PARENT_ID,
  relationshipToParent: "subagent" as const,
};

const summaryOf = (ref: PullRequestRef): PullRequestSummary => ({
  provider: SourceControlProviderKind.make("github"),
  projectId: ref.projectId,
  repository: ref.repository,
  number: ref.number,
  title: `PR ${ref.number}`,
  url: `https://github.com/${ref.repository}/pull/${ref.number}`,
  state: "open",
  headBranch: "feature",
  baseBranch: "main",
  updatedAt: "2026-10-30T19:00:00.000Z",
  observedAt: Date.UTC(2026, 9, 30, 19, 20, 2),
  reviewDecision: "approved",
  mergeability: "mergeable",
});

const check = (
  name: string,
  status: PullRequestCheck["status"],
  extra: Partial<PullRequestCheck> = {},
): PullRequestCheck => ({ name, status, description: null, url: null, ...extra });

const checksOf = (list: ReadonlyArray<PullRequestCheck>): PullRequestChecks => ({
  headSha: "5b7e2d9c0ffee",
  observedAt: Date.UTC(2026, 9, 30, 19, 20, 11),
  state: "open",
  checks: list,
});

const paused = (operation: string) =>
  new PullRequestOperationError({
    operation,
    detail: "paused",
    cause: new PullRequestProviderError({
      provider: SourceControlProviderKind.make("github"),
      operation,
      reason: "rate-limited",
      detail: "paused",
      retryAt: RETRY_AT,
    }),
  });

const failureOf = (handle: string): PullRequestCheckFailure => ({
  check: handle,
  status: "failure",
  url: null,
  attempt: 1,
  failedSteps: ["Run vp lint"],
  annotations: [],
  log: { _tag: "excerpt", text: "error", totalLines: 1, truncated: false },
});

interface Harness {
  readonly publicReads?: boolean;
  readonly threads?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly service?: Partial<PullRequestService.PullRequestService["Service"]>;
}

const makeOracle = Effect.fn("makeOracle")(function* (options: Harness = {}) {
  const reads = yield* Ref.make<ReadonlyArray<string>>([]);
  const record = (operation: string, ref: PullRequestRef) =>
    Ref.update(reads, (seen) => [...seen, `${operation} ${ref.repository}#${ref.number}`]);
  const threads = options.threads ?? [];
  const layer = PullRequestOracle.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          PullRequestProviderRegistry.PullRequestProviderRegistry,
          PullRequestProviderRegistry.fromProviders([
            fakePullRequestProvider("github", {
              readsPublicHostWithoutCheckout: options.publicReads ?? false,
            }),
          ]),
        ),
        Layer.mock(PullRequestService.PullRequestService)({
          summary: (ref) => record("summary", ref).pipe(Effect.as(summaryOf(ref))),
          checks: (ref) =>
            record("checks", ref).pipe(Effect.as(checksOf([check("build", "success")]))),
          activity: (ref) =>
            record("activity", ref).pipe(
              Effect.as({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
            ),
          checkFailures: (input) =>
            record(`failure:${input.handle}`, input).pipe(Effect.as(failureOf(input.handle))),
          ...options.service,
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadShell: (id) =>
            Effect.succeed(threads.find((candidate) => candidate.id === id) ?? null),
        }),
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.succeed(options.projects ?? PROJECTS),
        }),
      ),
    ),
  );
  const oracle = yield* PullRequestOracle.PullRequestOracle.pipe(Effect.provide(layer));
  return { oracle, reads: Ref.get(reads), caller: { threadId: THREAD_ID } };
});

describe("PullRequestOracle default targets", () => {
  it.effect("reads the thread's open links and skips settled ones", () =>
    Effect.gen(function* () {
      const { oracle, caller, reads } = yield* makeOracle({
        threads: [
          thread(THREAD_ID, {
            pullRequests: [link(1, { state: "merged" }), link(2, { state: "open" }), link(3)],
            branchPullRequest: {
              projectId: PROJECT_ID,
              repository: "acme/app",
              number: 9,
              url: "u",
            },
          }),
        ],
      });
      const report = yield* oracle.status({ caller });
      assert.deepEqual(
        report.pullRequests.map((entry) => [entry._tag, "number" in entry ? entry.number : null]),
        [
          ["Status", 2],
          ["Status", 3],
        ],
      );
      const [first] = report.pullRequests;
      assert.equal(first?._tag === "Status" && first.resolvedVia, "linked");
      assert.equal(
        first?._tag === "Status" && first.report,
        "PR https://github.com/acme/app/pull/2, head 5b7e2d9, checks passing (1 passed), reviews approved, mergeable",
      );
      assert.deepEqual(yield* reads, [
        "summary acme/app#2",
        "checks acme/app#2",
        "summary acme/app#3",
        "checks acme/app#3",
      ]);
    }),
  );

  it.effect("falls back to the parent's links for a child, then to the branch's pull request", () =>
    Effect.gen(function* () {
      const parent = thread(PARENT_ID, { pullRequests: [link(7, { state: "open" })] });
      const viaParent = yield* makeOracle({
        threads: [thread(THREAD_ID, { lineage: childLineage }), parent],
      });
      const inherited = yield* viaParent.oracle.status({ caller: viaParent.caller });
      assert.deepEqual(
        inherited.pullRequests.map(
          (entry) => entry._tag === "Status" && [entry.number, entry.resolvedVia],
        ),
        [[7, "parent-linked"]],
      );

      const viaBranch = yield* makeOracle({
        threads: [
          thread(THREAD_ID, {
            lineage: childLineage,
            branchPullRequest: {
              projectId: PROJECT_ID,
              repository: "acme/app",
              number: 9,
              url: "https://github.com/acme/app/pull/9",
            },
          }),
          thread(PARENT_ID, { pullRequests: [link(7, { state: "closed" })] }),
        ],
      });
      const branch = yield* viaBranch.oracle.status({ caller: viaBranch.caller });
      assert.deepEqual(
        branch.pullRequests.map(
          (entry) => entry._tag === "Status" && [entry.number, entry.resolvedVia],
        ),
        [[9, "branch"]],
      );
    }),
  );

  it.effect("tells the agent to name a pull request when nothing resolves", () =>
    Effect.gen(function* () {
      const { oracle, caller } = yield* makeOracle({ threads: [thread(THREAD_ID)] });
      const error = yield* oracle.status({ caller }).pipe(Effect.flip);
      assert.equal(error._tag, "PullRequestOracleNoTargetError");
      assert.include(error.message, "pass url, or repository and number");

      const noThread = yield* makeOracle();
      const outside = yield* noThread.oracle
        .status({ caller: { threadId: null } })
        .pipe(Effect.flip);
      assert.equal(outside._tag, "PullRequestOracleNoTargetError");
    }),
  );

  it.effect("refuses to guess between several pull requests for a single read", () =>
    Effect.gen(function* () {
      const { oracle, caller } = yield* makeOracle({
        threads: [
          thread(THREAD_ID, {
            pullRequests: [link(1, { state: "open" }), link(2, { state: "open" })],
          }),
        ],
      });
      const error = yield* oracle.feedback({ caller }).pipe(Effect.flip);
      assert.equal(error._tag, "PullRequestOracleAmbiguousTargetError");
      assert.include(
        error.message,
        "https://github.com/acme/app/pull/1, https://github.com/acme/app/pull/2",
      );
    }),
  );
});

describe("PullRequestOracle named targets", () => {
  it.effect(
    "reads a named pull request through the project that holds it and keeps per-PR errors",
    () =>
      Effect.gen(function* () {
        const { oracle, caller, reads } = yield* makeOracle({ threads: [thread(THREAD_ID)] });
        const report = yield* oracle.status({
          caller,
          pullRequests: [
            { url: "https://github.com/acme/docs/pull/4" },
            { number: 5 },
            { url: "https://example.com/not-a-pr" },
            { repository: "acme/unknown", number: 6 },
          ],
        });
        assert.deepEqual(
          report.pullRequests.map((entry) =>
            entry._tag === "Status"
              ? [entry.number, entry.resolvedVia]
              : [entry._tag, "url" in entry ? entry.url : undefined, entry.message],
          ),
          [
            [4, "named"],
            [5, "named"],
            [
              "Unavailable",
              "https://example.com/not-a-pr",
              "This is not a recognised pull request URL. Pass repository and number instead.",
            ],
            [
              "Unavailable",
              "https://github.com/acme/unknown/pull/6",
              "No project in this environment is a checkout of acme/unknown, so its pull requests cannot be read here. Add one with t3_project_create.",
            ],
          ],
        );
        assert.include(yield* reads, "summary acme/docs#4");
      }),
  );

  it.effect("reads fork PRs through the checkout origin", () =>
    Effect.gen(function* () {
      const upstream = project(PROJECT_ID, "pingdotgg", "t3code");
      const fork = {
        ...upstream,
        repositoryIdentity: {
          ...upstream.repositoryIdentity!,
          origin: { canonicalKey: "github.com/scriptedalchemy/t3code" },
        },
      };
      const { oracle, caller } = yield* makeOracle({
        threads: [thread(THREAD_ID)],
        projects: [fork],
      });
      const report = yield* oracle.status({
        caller,
        pullRequests: [{ url: "https://github.com/ScriptedAlchemy/t3code/pull/24" }],
      });
      assert.equal(report.pullRequests[0]?._tag, "Status");
    }),
  );

  it.effect("reads a public repository through the caller's same-host checkout", () =>
    Effect.gen(function* () {
      const { oracle, caller } = yield* makeOracle({
        threads: [thread(THREAD_ID)],
        publicReads: true,
      });
      const report = yield* oracle.status({
        caller,
        pullRequests: [{ url: "https://github.com/elsewhere/app/pull/24" }],
      });
      assert.equal(report.pullRequests[0]?._tag, "Status");
      const withoutCaller = yield* oracle.status({
        caller: { threadId: null },
        pullRequests: [{ url: "https://github.com/elsewhere/app/pull/24" }],
      });
      assert.equal(withoutCaller.pullRequests[0]?._tag, "Unavailable");
      const enterprise = project(PROJECT_ID, "acme", "app");
      const onAnotherHost = yield* makeOracle({
        threads: [thread(THREAD_ID)],
        publicReads: true,
        projects: [
          {
            ...enterprise,
            repositoryIdentity: {
              ...enterprise.repositoryIdentity!,
              canonicalKey: "github.company/acme/app",
              locator: {
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: "https://github.company/acme/app.git",
              },
            },
          },
        ],
      });
      const crossHost = yield* onAnotherHost.oracle.status({
        caller,
        pullRequests: [{ url: "https://github.com/elsewhere/app/pull/24" }],
      });
      assert.equal(crossHost.pullRequests[0]?._tag, "Unavailable");
    }),
  );

  it.effect("fails a single read with the typed target error", () =>
    Effect.gen(function* () {
      const { oracle, caller } = yield* makeOracle({ threads: [thread(THREAD_ID)] });
      const error = yield* oracle
        .failures({ caller, pullRequests: [{ repository: "acme/app" }] })
        .pipe(Effect.flip);
      assert.equal(error._tag, "PullRequestTargetIncompleteError");
      const noProject = yield* oracle
        .failures({ caller: { threadId: null }, pullRequests: [{ number: 123 }] })
        .pipe(Effect.flip);
      assert.equal(noProject._tag, "PullRequestTargetIncompleteError");
    }),
  );
});

describe("PullRequestOracle rate limits", () => {
  it.effect("turns a paused credential into a rate-limited answer that names the time", () =>
    Effect.gen(function* () {
      const expected = {
        _tag: "RateLimited" as const,
        until: "2026-10-30T20:05:00.000Z",
        message:
          "GitHub is rate limited for this account until 20:05 UTC. Your gh shares that limit; stop GitHub reads until then.",
      };
      const target = { pullRequests: [{ repository: "acme/app", number: 5 }] };
      const summaryPaused = yield* makeOracle({
        threads: [thread(THREAD_ID)],
        service: { summary: () => paused("summary") },
      });
      const status = yield* summaryPaused.oracle.status({
        caller: summaryPaused.caller,
        ...target,
      });
      assert.deepEqual(status.pullRequests, [expected]);
      assert.deepEqual(
        yield* summaryPaused.oracle.feedback({ caller: summaryPaused.caller, ...target }),
        expected,
      );

      const checksPaused = yield* makeOracle({
        threads: [thread(THREAD_ID)],
        service: { checks: () => paused("checks") },
      });
      assert.deepEqual(
        (yield* checksPaused.oracle.status({ caller: checksPaused.caller, ...target }))
          .pullRequests,
        [expected],
      );
      assert.deepEqual(
        yield* checksPaused.oracle.failures({ caller: checksPaused.caller, ...target }),
        expected,
      );
    }),
  );

  it.effect(
    "reports a status without checks when only the checks read fails for another reason",
    () =>
      Effect.gen(function* () {
        const { oracle, caller } = yield* makeOracle({
          threads: [thread(THREAD_ID)],
          service: {
            checks: () => new PullRequestOperationError({ operation: "checks", detail: "boom" }),
          },
        });
        const report = yield* oracle.status({
          caller,
          pullRequests: [{ repository: "acme/app", number: 5 }],
        });
        const [entry] = report.pullRequests;
        assert.equal(entry?._tag === "Status" && entry.checks.verdict, "unknown");
      }),
  );
});

describe("PullRequestOracle.failures", () => {
  it.effect("reads at most five failing checks with handles and reports the rest", () =>
    Effect.gen(function* () {
      const list = [
        ...Array.from({ length: 6 }, (_, index) =>
          check(`job-${index}`, "failure", { handle: `github-check:${index}:1` }),
        ),
        check("external", "failure", { url: "https://ci.example/7" }),
        check("build", "success", { handle: "github-check:9:1" }),
      ];
      const { oracle, caller } = yield* makeOracle({
        threads: [thread(THREAD_ID, { pullRequests: [link(5, { state: "open" })] })],
        service: {
          checks: () => Effect.succeed(checksOf(list)),
          checkFailures: (input) =>
            input.handle === "github-check:1:1"
              ? new PullRequestOperationError({ operation: "checkFailures", detail: "gone" })
              : Effect.succeed(failureOf(input.handle)),
        },
      });
      const report = yield* oracle.failures({ caller });
      assert.equal(report._tag, "Failures");
      if (report._tag !== "Failures") return;
      assert.equal(report.headSha, "5b7e2d9c0ffee");
      assert.equal(report.observedAt, "2026-10-30T19:20:11.000Z");
      assert.deepEqual(
        report.failures.map((failure) => failure.check),
        ["github-check:0:1", "github-check:2:1", "github-check:3:1", "github-check:4:1"],
      );
      assert.deepEqual(report.omitted, [
        { name: "job-5", status: "failure", url: null, reason: "over-limit" },
        { name: "external", status: "failure", url: "https://ci.example/7", reason: "no-handle" },
        { name: "job-1", status: "failure", url: null, reason: "read-failed" },
      ]);
    }),
  );

  it.effect("reads only the named checks", () =>
    Effect.gen(function* () {
      const { oracle, caller, reads } = yield* makeOracle({
        threads: [thread(THREAD_ID, { pullRequests: [link(5, { state: "open" })] })],
        service: {
          checks: () =>
            Effect.succeed(
              checksOf([
                check("lint", "failure", { handle: "github-check:1:1" }),
                check("test", "failure", { handle: "github-check:2:1" }),
              ]),
            ),
        },
      });
      const report = yield* oracle.failures({ caller, checks: ["Test"] });
      assert.deepEqual(
        report._tag === "Failures" && report.failures.map((failure) => failure.check),
        ["github-check:2:1"],
      );
      assert.deepEqual(
        (yield* reads).filter((read) => read.startsWith("failure:")),
        ["failure:github-check:2:1 acme/app#5"],
      );
    }),
  );
});
