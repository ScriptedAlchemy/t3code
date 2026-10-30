import { assert, describe, it } from "@effect/vitest";
import {
  type PullRequestActivity,
  type PullRequestCheck,
  type PullRequestChecks,
  PullRequestOperationError,
  type PullRequestSummary,
  PullRequestUnavailableError,
  ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";

import {
  checksStatusOf,
  feedbackOf,
  rateLimitedOf,
  reportLineOf,
  selectCheckFailures,
  statusEntryOf,
} from "./pullRequestReports.ts";

const URL = "https://github.com/acme/app/pull/123";

const check = (
  name: string,
  status: PullRequestCheck["status"],
  extra: Partial<PullRequestCheck> = {},
): PullRequestCheck => ({ name, status, description: null, url: null, ...extra });

const checks = (
  list: ReadonlyArray<PullRequestCheck>,
  headSha = "5b7e2d9c0ffee",
): PullRequestChecks => ({
  headSha,
  observedAt: Date.UTC(2026, 9, 30, 19, 20, 11),
  state: "open",
  checks: list,
});

const summary = (overrides: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project-1"),
  repository: "acme/app",
  number: 123,
  title: "Fix lint",
  url: URL,
  state: "open",
  isDraft: false,
  headBranch: "fix/lint",
  baseBranch: "main",
  updatedAt: "2026-10-30T19:00:00.000Z",
  observedAt: Date.UTC(2026, 9, 30, 19, 20, 2),
  reviewDecision: "changes-requested",
  mergeability: "mergeable",
  ...overrides,
});

const GITHUB = { label: "GitHub", cli: "gh" };

describe("checksStatusOf", () => {
  it.each([
    { name: "no checks read", list: null, verdict: "unknown" },
    { name: "an empty list", list: [], verdict: "none" },
    { name: "all green", list: [check("a", "success"), check("b", "neutral")], verdict: "passing" },
    {
      name: "a skipped check among green",
      list: [check("a", "success"), check("b", "skipped")],
      verdict: "passing",
    },
    {
      name: "one pending",
      list: [check("a", "success"), check("b", "pending")],
      verdict: "pending",
    },
    {
      name: "a failure beats pending",
      list: [check("a", "pending"), check("b", "failure")],
      verdict: "failing",
    },
    { name: "a cancelled check", list: [check("a", "cancelled")], verdict: "failing" },
    { name: "action required", list: [check("a", "action-required")], verdict: "failing" },
  ] as const)("reads $name as $verdict", ({ list, verdict }) => {
    assert.equal(checksStatusOf(list === null ? null : checks(list)).verdict, verdict);
  });

  it("counts by outcome and keeps required as yes, no, or unknown", () => {
    const status = checksStatusOf(
      checks([
        check("lint", "failure", {
          required: true,
          handle: "github-check:1:1",
          summary: "2 errors",
        }),
        check("test", "failure", { required: false }),
        check("e2e", "pending"),
        check("docs", "skipped"),
        check("build", "success"),
      ]),
    );
    assert.deepEqual(status, {
      verdict: "failing",
      headSha: "5b7e2d9c0ffee",
      passed: 1,
      failed: 2,
      pending: 1,
      skipped: 1,
      failing: [
        {
          name: "lint",
          required: "yes",
          status: "failure",
          handle: "github-check:1:1",
          summary: "2 errors",
          url: null,
        },
        { name: "test", required: "no", status: "failure", url: null },
      ],
      waiting: [{ name: "e2e", required: "unknown" }],
    });
  });
});

describe("statusEntryOf", () => {
  it.each([
    {
      name: "older successful checks",
      summaryHead: "newhead",
      checksHead: "oldhead",
      summaryAt: 20,
      checksAt: 10,
      head: "newhead",
      verdict: "stale-head",
    },
    {
      name: "newer successful checks",
      summaryHead: "oldhead",
      checksHead: "newhead",
      summaryAt: 10,
      checksAt: 20,
      head: "newhead",
      verdict: "passing",
    },
    {
      name: "matching heads",
      summaryHead: "newhead",
      checksHead: "newhead",
      summaryAt: 20,
      checksAt: 10,
      head: "newhead",
      verdict: "passing",
    },
    {
      name: "unknown ordering",
      summaryHead: "newhead",
      checksHead: "oldhead",
      summaryAt: undefined,
      checksAt: undefined,
      head: "newhead",
      verdict: "stale-head",
    },
  ])(
    "keeps head coherence for $name",
    ({ summaryHead, checksHead, summaryAt, checksAt, head, verdict }) => {
      const entry = statusEntryOf({
        url: URL,
        resolvedVia: "named",
        summary: summary({ headSha: summaryHead, observedAt: summaryAt, checksState: "pending" }),
        checks: { ...checks([check("build", "success")], checksHead), observedAt: checksAt },
      });
      assert.equal(entry.headSha, head);
      assert.equal(entry.checks.headSha, checksHead);
      assert.equal(entry.checks.verdict, verdict);
      if (verdict === "stale-head") assert.notInclude(entry.report, "checks passing");
    },
  );

  it.each([
    {
      name: "failing checks with one pending",
      summary: summary(),
      checks: checks([
        check("lint", "failure"),
        check("e2e", "pending"),
        check("build", "success"),
      ]),
      report:
        "PR https://github.com/acme/app/pull/123, head 5b7e2d9, checks failing (lint; 1 pending), reviews changes requested, mergeable",
    },
    {
      name: "many failing checks",
      summary: summary({ reviewDecision: null, mergeability: "conflicting" }),
      checks: checks([
        check("a", "failure"),
        check("b", "failure"),
        check("c", "failure"),
        check("d", "cancelled"),
      ]),
      report:
        "PR https://github.com/acme/app/pull/123, head 5b7e2d9, checks failing (a, b, c, +1 more), reviews none, conflicting",
    },
    {
      name: "pending checks",
      summary: summary({ reviewDecision: "review-required", mergeability: undefined }),
      checks: checks([check("a", "pending"), check("b", "pending")]),
      report:
        "PR https://github.com/acme/app/pull/123, head 5b7e2d9, checks pending (2 pending), reviews required, mergeability unknown",
    },
    {
      name: "a green approved pull request",
      summary: summary({ reviewDecision: "approved" }),
      checks: checks([check("a", "success"), check("b", "success")]),
      report:
        "PR https://github.com/acme/app/pull/123, head 5b7e2d9, checks passing (2 passed), reviews approved, mergeable",
    },
    {
      name: "a merged pull request without a checks read",
      summary: summary({ state: "merged", reviewDecision: "approved" }),
      checks: null,
      report:
        "PR https://github.com/acme/app/pull/123, head unknown, checks unknown, reviews approved, merged",
    },
    {
      name: "a head with no checks yet",
      summary: summary(),
      checks: checks([]),
      report:
        "PR https://github.com/acme/app/pull/123, head 5b7e2d9, checks none, reviews changes requested, mergeable",
    },
  ])("reports $name", ({ summary, checks, report }) => {
    const entry = statusEntryOf({ url: URL, resolvedVia: "linked", summary, checks });
    assert.equal(entry.report, report);
    assert.equal(reportLineOf(entry), report);
  });

  it("takes the head from the checks and dates each facet", () => {
    const entry = statusEntryOf({
      url: URL,
      resolvedVia: "parent-linked",
      summary: summary(),
      checks: checks([]),
    });
    assert.equal(entry.headSha, "5b7e2d9c0ffee");
    assert.deepEqual(entry.observedAt, {
      summary: "2026-10-30T19:20:02.000Z",
      checks: "2026-10-30T19:20:11.000Z",
    });
    assert.equal(entry.resolvedVia, "parent-linked");
  });
});

describe("selectCheckFailures", () => {
  const failing = Array.from({ length: 7 }, (_, index) =>
    check(`job-${index}`, "failure", { handle: `github-check:${index}:1`, required: index === 6 }),
  );

  it("reads required failing checks first, at most five, and reports the rest", () => {
    const { chosen, omitted } = selectCheckFailures(
      [
        ...failing,
        check("no-handle", "failure", { url: "https://ci.example/1" }),
        check("ok", "success"),
      ],
      undefined,
    );
    assert.deepEqual(
      chosen.map((check) => check.name),
      ["job-6", "job-0", "job-1", "job-2", "job-3"],
    );
    assert.deepEqual(omitted, [
      { name: "job-4", status: "failure", url: null, reason: "over-limit" },
      { name: "job-5", status: "failure", url: null, reason: "over-limit" },
      { name: "no-handle", status: "failure", url: "https://ci.example/1", reason: "no-handle" },
    ]);
  });

  it("reads the named checks whatever their status", () => {
    const { chosen, omitted } = selectCheckFailures(
      [
        check("Lint", "success", { handle: "github-check:9:1" }),
        check("test", "failure", { handle: "h" }),
      ],
      ["lint"],
    );
    assert.deepEqual(
      chosen.map((check) => check.name),
      ["Lint"],
    );
    assert.deepEqual(omitted, []);
  });
});

describe("feedbackOf", () => {
  const actor = (login: string, isBot = false) => ({ login, name: null, avatarUrl: null, isBot });
  const threadComment = (author: string, body: string, createdAt: string) => ({
    id: `${author}-${createdAt}`,
    author: actor(author, author === "bot"),
    body,
    createdAt,
    url: `https://github.com/acme/app/pull/123#discussion_r${createdAt}`,
  });
  const activity: PullRequestActivity = {
    comments: [
      {
        id: "c1",
        kind: "issue-comment",
        author: actor("alice"),
        body: "Please split this.",
        createdAt: "2026-10-30T10:00:00Z",
        url: null,
        path: null,
        reviewState: null,
      },
      {
        id: "r1",
        kind: "review",
        author: actor("bob"),
        body: "",
        createdAt: "2026-10-30T12:00:00Z",
        url: null,
        path: null,
        reviewState: "APPROVED",
      },
      {
        id: "r2",
        kind: "review",
        author: actor("carol"),
        body: "",
        createdAt: "2026-10-30T12:30:00Z",
        url: null,
        path: null,
        reviewState: null,
      },
      {
        id: "rc1",
        kind: "review-comment",
        author: actor("bob"),
        body: "repeated in the thread",
        createdAt: "2026-10-30T13:00:00Z",
        url: null,
        path: "src/a.ts",
        reviewState: null,
      },
    ],
    commentCount: 4,
    commentsTruncated: false,
    reviewThreads: [
      {
        id: "t-resolved",
        path: "src/a.ts",
        line: 1,
        side: "right",
        isResolved: true,
        isOutdated: false,
        comments: [threadComment("bob", "done", "2026-10-30T09:00:00Z")],
      },
      {
        id: "t-outdated",
        path: "src/a.ts",
        line: 2,
        side: "right",
        isResolved: false,
        isOutdated: true,
        comments: [threadComment("bob", "stale", "2026-10-30T09:30:00Z")],
      },
      {
        id: "t-old",
        path: "src/b.ts",
        line: 12,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: [threadComment("bot", "Unused import.", "2026-10-30T08:00:00Z")],
      },
      {
        id: "t-new",
        path: "src/c.ts",
        line: null,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: [
          threadComment("alice", "Rename this.", "2026-10-30T11:00:00Z"),
          threadComment("dev", "Why?", "2026-10-30T11:30:00Z"),
        ],
      },
    ],
    commits: [],
  };

  it("keeps open threads and spoken comments, newest first", () => {
    const feedback = feedbackOf({ url: URL, summary: summary(), activity });
    assert.deepEqual(
      feedback.threads.map((thread) => thread.id),
      ["t-new", "t-old"],
    );
    assert.deepEqual(feedback.threads[1], {
      id: "t-old",
      path: "src/b.ts",
      line: 12,
      url: "https://github.com/acme/app/pull/123#discussion_r2026-10-30T08:00:00Z",
      comments: [
        { author: "bot", isBot: true, body: "Unused import.", createdAt: "2026-10-30T08:00:00Z" },
      ],
    });
    assert.deepEqual(
      feedback.comments.map((comment) => comment.id),
      ["r1", "c1"],
    );
    assert.equal(feedback.reviewDecision, "changes-requested");
    assert.isFalse(feedback.truncated);
  });

  it("bounds the lists and says so", () => {
    const many = {
      ...activity,
      comments: Array.from({ length: 31 }, (_, index) => ({
        ...activity.comments[0]!,
        id: `c${index}`,
        body: "x".repeat(2100),
        createdAt: `2026-10-${String(1 + (index % 28)).padStart(2, "0")}T10:00:00Z`,
      })),
    };
    const feedback = feedbackOf({ url: URL, summary: summary(), activity: many });
    assert.equal(feedback.comments.length, 30);
    assert.equal(feedback.comments[0]!.body.length, 2000);
    assert.isTrue(feedback.truncated);
  });
});

describe("rateLimitedOf", () => {
  const paused = (retryAt?: number) =>
    new PullRequestOperationError({
      operation: "summary",
      detail: "paused",
      cause: new PullRequestProviderError({
        provider: SourceControlProviderKind.make("github"),
        operation: "summary",
        reason: "rate-limited",
        detail: "paused",
        ...(retryAt === undefined ? {} : { retryAt }),
      }),
    });

  it("names the time and tells the agent its CLI shares the limit", () => {
    assert.deepEqual(rateLimitedOf(paused(Date.UTC(2026, 9, 30, 20, 5)), GITHUB, 0), {
      _tag: "RateLimited",
      until: "2026-10-30T20:05:00.000Z",
      message:
        "GitHub is rate limited for this account until 20:05 UTC. Your gh shares that limit; stop GitHub reads until then.",
    });
  });

  it("is null for any other failure", () => {
    assert.isNull(
      rateLimitedOf(
        new PullRequestOperationError({ operation: "summary", detail: "boom" }),
        GITHUB,
        0,
      ),
    );
    assert.isNull(
      rateLimitedOf(new PullRequestUnavailableError({ reason: "provider-unsupported" }), GITHUB, 0),
    );
  });

  it("waits a minute when the host named no retry time", () => {
    assert.equal(
      rateLimitedOf(paused(), GITHUB, Date.UTC(2026, 9, 30, 20, 0))?.until,
      "2026-10-30T20:01:00.000Z",
    );
  });
});
