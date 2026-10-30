import { describe, expect, it } from "vite-plus/test";

import { classifyGhCommand } from "./ghCommand.ts";

const words = (command: string) => command.split(" ");

describe("classifyGhCommand", () => {
  it.each([
    // Status reads pull_request_status answers.
    ["gh pr checks 4497", { kind: "read", intent: "status", target: { number: 4497 } }],
    [
      "gh pr checks 4499 -R acme/app",
      { kind: "read", intent: "status", target: { repository: "acme/app", number: 4499 } },
    ],
    [
      "gh pr checks --repo acme/app 4503 --json bucket",
      { kind: "read", intent: "status", target: { repository: "acme/app", number: 4503 } },
    ],
    ["gh pr checks", { kind: "read", intent: "status", target: {} }],
    ["gh pr checks feature-branch", { kind: "other" }],
    ["gh pr view feature-branch --comments", { kind: "other" }],
    [
      "gh pr checks https://github.com/acme/app/pull/12",
      { kind: "read", intent: "status", target: { url: "https://github.com/acme/app/pull/12" } },
    ],
    [
      "gh pr view 4396 --json headRefOid,mergeStateStatus,reviewDecision",
      { kind: "read", intent: "status", target: { number: 4396 } },
    ],
    [
      "gh pr view 4388 --json=headRefName,headRefOid,statusCheckRollup -q .headRefOid",
      { kind: "read", intent: "status", target: { number: 4388 } },
    ],
    // Feedback reads.
    ["gh pr view 12 --comments", { kind: "read", intent: "feedback", target: { number: 12 } }],
    [
      "gh pr view 12 --json reviews,latestReviews,comments",
      { kind: "read", intent: "feedback", target: { number: 12 } },
    ],
    [
      "gh api repos/acme/app/pulls/4391/reviews --jq .[].state",
      { kind: "read", intent: "feedback", target: { repository: "acme/app", number: 4391 } },
    ],
    [
      "gh api repos/acme/app/issues/4391/comments",
      { kind: "read", intent: "feedback", target: { repository: "acme/app", number: 4391 } },
    ],
    [
      "gh api /repos/acme/app/pulls/14178/comments?per_page=100 --paginate",
      { kind: "read", intent: "feedback", target: { repository: "acme/app", number: 14178 } },
    ],
    [
      "gh api repos/acme/app/pulls/$n/comments",
      { kind: "read", intent: "feedback", target: { repository: "acme/app" } },
    ],
    [
      "gh api repos/{owner}/{repo}/pulls/7/reviews",
      { kind: "read", intent: "feedback", target: { number: 7 } },
    ],
    // Failure reads.
    ["gh run view 39810344331 --log-failed", { kind: "read", intent: "failures", target: {} }],
    [
      "gh run view 39810344331 --job 119949521901 --log -R acme/app",
      { kind: "read", intent: "failures", target: { repository: "acme/app" } },
    ],
    [
      "gh api --allow-escape-sequences repos/acme/app/actions/jobs/119542773959/logs",
      { kind: "read", intent: "failures", target: { repository: "acme/app" } },
    ],
    [
      "gh api repos/acme/app/actions/jobs/119542773959 --jq {name,conclusion}",
      { kind: "read", intent: "failures", target: { repository: "acme/app" } },
    ],
    [
      "gh api https://api.github.com/repos/acme/app/check-runs/119542773959/annotations",
      { kind: "read", intent: "failures", target: { repository: "acme/app" } },
    ],
    [
      "gh api -X GET -f per_page=100 repos/acme/app/actions/jobs/1/logs",
      { kind: "read", intent: "failures", target: { repository: "acme/app" } },
    ],
    [
      "gh -R acme/app pr checks 123",
      { kind: "read", intent: "status", target: { repository: "acme/app", number: 123 } },
    ],
    [
      "gh --repo=acme/app pr checks 123",
      { kind: "read", intent: "status", target: { repository: "acme/app", number: 123 } },
    ],
    [
      "gh -R=acme/app pr checks 123",
      { kind: "read", intent: "status", target: { repository: "acme/app", number: 123 } },
    ],
    [
      "gh --hostname=github.com api repos/acme/app/pulls/4/reviews",
      { kind: "read", intent: "feedback", target: { repository: "acme/app", number: 4 } },
    ],
    ["gh -R acme/app pr checks 123 --watch", { kind: "poll" }],
    [
      "gh --hostname github.com api --method GET repos/acme/app/pulls/4/reviews",
      { kind: "read", intent: "feedback", target: { repository: "acme/app", number: 4 } },
    ],
    // Polls.
    ["gh pr checks 4497 --watch", { kind: "poll" }],
    ["gh run watch 39810344331", { kind: "poll" }],
    // Writes stay with the agent.
    ["gh pr create --fill", { kind: "write" }],
    ["gh pr merge 31 --auto --squash --match-head-commit abc", { kind: "write" }],
    ["gh pr edit 4472 --repo acme/app --body-file pr-body.md", { kind: "write" }],
    ["gh pr comment 4 --body hi", { kind: "write" }],
    ["gh pr review 4 --approve", { kind: "write" }],
    ["gh run rerun 1 --failed", { kind: "write" }],
    ["gh workflow run ci.yml", { kind: "write" }],
    ["gh api -X POST repos/acme/app/pulls/4/comments -f body=hi", { kind: "write" }],
    ["gh api --method PATCH repos/acme/app/pulls/4 -F draft=false", { kind: "write" }],
    ["gh api repos/acme/app/pulls/4/reviews -f event=APPROVE", { kind: "write" }],
    ["gh api graphql --input -", { kind: "write" }],
    ["gh api graphql -f query=query{viewer{login}}", { kind: "write" }],
    ["gh api repos/acme/app/pulls/4/reviews -fevent=APPROVE", { kind: "write" }],
    ["gh api repos/acme/app/pulls/4/reviews -Fevent=APPROVE", { kind: "write" }],
    ["gh api repos/acme/app/pulls/4/reviews -XPOST", { kind: "write" }],
    // Nothing a tool answers exactly.
    ["gh pr view 4393", { kind: "other" }],
    ["gh pr view 4393 --json headRefOid,files", { kind: "other" }],
    ["gh pr view 4393 --json statusCheckRollup,reviews", { kind: "other" }],
    ["gh pr view 4393 --web", { kind: "other" }],
    ["gh pr diff 4361 --name-only", { kind: "other" }],
    ["gh pr list -R acme/app --draft --json number,title,url", { kind: "other" }],
    ["gh pr checkout 12", { kind: "other" }],
    ["gh run view 39842550033 --json status,jobs", { kind: "other" }],
    ["gh run list --workflow ci.yml --limit 40", { kind: "other" }],
    ["gh run download 1", { kind: "other" }],
    ["gh api rate_limit --jq .resources.core", { kind: "other" }],
    ["gh api repos/acme/app/commits/8c8b404/check-runs", { kind: "other" }],
    ["gh api repos/acme/app/actions/runs/1/jobs", { kind: "other" }],
    ["gh api repos/actions/setup-python/releases/tags/v7.1.0", { kind: "other" }],
    ["gh search prs --review-requested=@me", { kind: "other" }],
    ["gh issue list --state open --limit 150", { kind: "other" }],
    ["gh auth status", { kind: "other" }],
    ["gh", { kind: "other" }],
  ] as const)("%s", (command, expected) => {
    expect(classifyGhCommand(words(command))).toEqual(expected);
  });

  it("leaves other programs alone", () => {
    expect(classifyGhCommand(["glab", "mr", "view", "1"])).toBeNull();
    expect(classifyGhCommand(["git", "push"])).toBeNull();
  });
});
