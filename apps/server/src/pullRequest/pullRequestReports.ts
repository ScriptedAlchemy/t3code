import {
  type PullRequestActivity,
  type PullRequestCheck,
  type PullRequestCheckRequired,
  type PullRequestChecks,
  type PullRequestChecksStatus,
  type PullRequestFailureReport,
  type PullRequestFeedbackReport,
  type PullRequestOperationError,
  type PullRequestRateLimited,
  type PullRequestResolvedVia,
  type PullRequestStatusEntry,
  type PullRequestSummary,
  type PullRequestUnavailableError,
} from "@t3tools/contracts";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import { isFailedCheck } from "@t3tools/source-control-core/server/pullRequestChecks";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const LISTED_CHECKS = 20;
const REPORTED_FAILING = 3;
const FEEDBACK_ITEMS = 30;
const THREAD_COMMENTS = 10;
const FEEDBACK_BODY = 2000;
const CHECK_SUMMARY = 300;
const FAILURE_READS = 5;
const RATE_LIMIT_FALLBACK_MS = 60_000;

const isProviderError = Schema.is(PullRequestProviderError);

const requiredOf = (check: PullRequestCheck): PullRequestCheckRequired =>
  check.required === true ? "yes" : check.required === false ? "no" : "unknown";

export const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export function checksStatusOf(checks: PullRequestChecks | null): PullRequestChecksStatus {
  if (checks === null) {
    return {
      verdict: "unknown",
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      failing: [],
      waiting: [],
    };
  }
  const failing = checks.checks.filter(isFailedCheck);
  const waiting = checks.checks.filter((check) => check.status === "pending");
  const skipped = checks.checks.filter((check) => check.status === "skipped").length;
  const passed = checks.checks.length - failing.length - waiting.length - skipped;
  return {
    verdict:
      failing.length > 0
        ? "failing"
        : waiting.length > 0
          ? "pending"
          : checks.checks.length === 0
            ? "none"
            : "passing",
    ...(checks.headSha === undefined ? {} : { headSha: checks.headSha }),
    passed,
    failed: failing.length,
    pending: waiting.length,
    skipped,
    failing: failing.slice(0, LISTED_CHECKS).map((check) => ({
      name: check.name,
      required: requiredOf(check),
      status: check.status,
      ...(check.handle === undefined ? {} : { handle: check.handle }),
      ...(check.summary === undefined ? {} : { summary: clip(check.summary, CHECK_SUMMARY) }),
      url: check.url,
    })),
    waiting: waiting
      .slice(0, LISTED_CHECKS)
      .map((check) => ({ name: check.name, required: requiredOf(check) })),
  };
}

const REVIEW_LABELS: Record<NonNullable<PullRequestSummary["reviewDecision"]>, string> = {
  approved: "approved",
  "changes-requested": "changes requested",
  "review-required": "required",
};

function checksPhrase(checks: PullRequestChecksStatus): string {
  const pending = checks.pending > 0 ? `${checks.pending} pending` : null;
  switch (checks.verdict) {
    case "failing": {
      const names = checks.failing.slice(0, REPORTED_FAILING).map((check) => check.name);
      if (checks.failed > REPORTED_FAILING) names.push(`+${checks.failed - REPORTED_FAILING} more`);
      return `checks failing (${[names.join(", "), pending].filter(Boolean).join("; ")})`;
    }
    case "pending":
      return `checks pending (${pending})`;
    case "passing":
      return `checks passing (${checks.passed} passed)`;
    case "stale-head":
    case "none":
    case "unknown":
      return `checks ${checks.verdict}`;
  }
}

export function reportLineOf(entry: Omit<PullRequestStatusEntry, "_tag" | "report">): string {
  const head = entry.headSha === undefined ? "head unknown" : `head ${entry.headSha.slice(0, 7)}`;
  const reviews = `reviews ${entry.reviewDecision === null ? "none" : REVIEW_LABELS[entry.reviewDecision]}`;
  const last =
    entry.state !== "open"
      ? entry.state
      : entry.mergeability === "unknown"
        ? "mergeability unknown"
        : entry.mergeability;
  return `PR ${entry.url}, ${head}, ${checksPhrase(entry.checks)}, ${reviews}, ${last}`;
}

export function statusEntryOf(input: {
  readonly url: string;
  readonly resolvedVia: PullRequestResolvedVia;
  readonly summary: PullRequestSummary;
  readonly checks: PullRequestChecks | null;
}): PullRequestStatusEntry {
  const checkStatus = checksStatusOf(input.checks);
  const summaryHead = input.summary.headSha;
  const checksAreNewer =
    input.checks?.observedAt !== undefined &&
    input.summary.observedAt !== undefined &&
    input.checks.observedAt > input.summary.observedAt;
  const headSha = checksAreNewer
    ? (checkStatus.headSha ?? summaryHead)
    : (summaryHead ?? checkStatus.headSha);
  const checks: PullRequestChecksStatus =
    summaryHead !== undefined &&
    checkStatus.headSha !== undefined &&
    summaryHead !== checkStatus.headSha &&
    !checksAreNewer
      ? { ...checkStatus, verdict: "stale-head" }
      : checkStatus;
  const entry = {
    url: input.url,
    number: input.summary.number,
    title: input.summary.title,
    state: input.summary.state,
    isDraft: input.summary.isDraft === true,
    headBranch: input.summary.headBranch,
    baseBranch: input.summary.baseBranch,
    ...(headSha === undefined ? {} : { headSha }),
    mergeability: input.summary.mergeability ?? "unknown",
    reviewDecision: input.summary.reviewDecision ?? null,
    checks,
    observedAt: {
      ...(input.summary.observedAt === undefined
        ? {}
        : { summary: isoOf(input.summary.observedAt) }),
      ...(input.checks?.observedAt === undefined ? {} : { checks: isoOf(input.checks.observedAt) }),
    },
    resolvedVia: input.resolvedVia,
  } satisfies Omit<PullRequestStatusEntry, "_tag" | "report">;
  return { _tag: "Status", ...entry, report: reportLineOf(entry) };
}

/**
 * Which checks a failures read fetches: the named ones, else the failing ones, required first,
 * at most FAILURE_READS of those the host gave a handle for. The rest are reported, not read.
 */
export function selectCheckFailures(
  checks: ReadonlyArray<PullRequestCheck>,
  names: ReadonlyArray<string> | undefined,
): {
  readonly chosen: ReadonlyArray<PullRequestCheck & { readonly handle: string }>;
  readonly omitted: PullRequestFailureReport["omitted"];
} {
  const wanted =
    names === undefined
      ? checks.filter(isFailedCheck)
      : checks.filter((check) =>
          names.some((name) => name.toLowerCase() === check.name.toLowerCase()),
        );
  const ordered = [...wanted].sort(
    (a, b) => Number(b.required === true) - Number(a.required === true),
  );
  const chosen: Array<PullRequestCheck & { readonly handle: string }> = [];
  const omitted: Array<PullRequestFailureReport["omitted"][number]> = [];
  for (const check of ordered) {
    if (check.handle === undefined) {
      omitted.push({ name: check.name, status: check.status, url: check.url, reason: "no-handle" });
    } else if (chosen.length >= FAILURE_READS) {
      omitted.push({
        name: check.name,
        status: check.status,
        url: check.url,
        reason: "over-limit",
      });
    } else {
      chosen.push({ ...check, handle: check.handle });
    }
  }
  return { chosen, omitted };
}

const newestFirst = <T>(items: ReadonlyArray<T>, at: (item: T) => string) =>
  [...items].sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));

export function feedbackOf(input: {
  readonly url: string;
  readonly summary: PullRequestSummary;
  readonly activity: PullRequestActivity;
}): PullRequestFeedbackReport {
  const openThreads = input.activity.reviewThreads.filter(
    (thread) => !thread.isResolved && !thread.isOutdated,
  );
  const threads = newestFirst(openThreads, (thread) => thread.comments.at(-1)?.createdAt ?? "").map(
    (thread) => ({
      id: thread.id,
      path: thread.path,
      line: thread.line,
      url: thread.comments[0]?.url ?? null,
      comments: thread.comments.slice(-THREAD_COMMENTS).map((comment) => ({
        author: comment.author?.login ?? null,
        isBot: comment.author?.isBot === true,
        body: clip(comment.body, FEEDBACK_BODY),
        createdAt: comment.createdAt,
      })),
    }),
  );
  // Review-comment entries repeat the threads; a review with nothing said is only a verdict.
  const said = input.activity.comments.filter(
    (comment) =>
      comment.kind !== "review-comment" &&
      (comment.body.trim().length > 0 || comment.reviewState !== null),
  );
  const comments = newestFirst(said, (comment) => comment.createdAt).map((comment) => ({
    id: comment.id,
    kind: comment.kind,
    author: comment.author?.login ?? null,
    isBot: comment.author?.isBot === true,
    body: clip(comment.body, FEEDBACK_BODY),
    createdAt: comment.createdAt,
    url: comment.url,
    reviewState: comment.reviewState,
  }));
  return {
    _tag: "Feedback",
    url: input.url,
    number: input.summary.number,
    reviewDecision: input.summary.reviewDecision ?? null,
    threads: threads.slice(0, FEEDBACK_ITEMS),
    comments: comments.slice(0, FEEDBACK_ITEMS),
    truncated:
      threads.length > FEEDBACK_ITEMS ||
      comments.length > FEEDBACK_ITEMS ||
      input.activity.commentsTruncated ||
      input.activity.reviewThreadsTruncated === true ||
      openThreads.some((thread) => thread.comments.length > THREAD_COMMENTS),
  };
}

export interface ForgeWords {
  /** As "GitHub". */
  readonly label: string;
  /** As "gh". */
  readonly cli: string;
}

const rateLimitedCause = (error: PullRequestUnavailableError | PullRequestOperationError) =>
  error._tag === "PullRequestOperationError" &&
  isProviderError(error.cause) &&
  error.cause.reason === "rate-limited"
    ? error.cause
    : null;

/** The paused-credential failure as the tool tells it, or null for any other failure. */
export function rateLimitedOf(
  error: PullRequestUnavailableError | PullRequestOperationError,
  forge: ForgeWords,
  now: number,
): PullRequestRateLimited | null {
  const cause = rateLimitedCause(error);
  if (cause === null) return null;
  const until = isoOf(cause.retryAt ?? now + RATE_LIMIT_FALLBACK_MS);
  const time = `${until.slice(11, 16)} UTC`;
  return {
    _tag: "RateLimited",
    until,
    message: `${forge.label} is rate limited for this account until ${time}. Your ${forge.cli} shares that limit; stop ${forge.label} reads until then.`,
  };
}
