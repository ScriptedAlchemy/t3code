import { assert, describe, it } from "@effect/vitest";

import {
  decideGitHubCommand,
  POLL_DENIED_REASON,
  PULL_REQUEST_READ_TOOLS,
  pullRequestReadArguments,
} from "./agentGitHubReads.ts";

const redirect = (tool: keyof typeof PULL_REQUEST_READ_TOOLS, args: string, command: string) =>
  `T3 already reads this. Call ${PULL_REQUEST_READ_TOOLS[tool]} with ${args} (load it with ToolSearch if it is deferred). If it can't answer what you need, rerun as \`T3_GH_DIRECT=1 ${command}\`.`;

describe("decideGitHubCommand", () => {
  it.each([
    {
      name: "a checks read, to the status tool with the PR number",
      command: "gh pr checks 123",
      decision: {
        allow: false,
        reason: redirect("status", '{"pullRequests":[{"number":123}]}', "gh pr checks 123"),
      },
    },
    {
      name: "a read of the current branch's PR, to the default target",
      command: "gh pr checks --json bucket",
      decision: {
        allow: false,
        reason: redirect("status", "{}", "gh pr checks --json bucket"),
      },
    },
    {
      name: "a job log read, to the failures tool with the repository",
      command: "gh api repos/acme/app/actions/jobs/119542773959/logs",
      decision: {
        allow: false,
        reason: redirect("failures", "{}", "gh api repos/acme/app/actions/jobs/119542773959/logs"),
      },
    },
    {
      name: "a review read, to the feedback tool with repository and number",
      command: "gh api repos/acme/app/pulls/4391/reviews -R acme/app",
      decision: {
        allow: false,
        reason: redirect(
          "feedback",
          '{"pullRequests":[{"repository":"acme/app","number":4391}]}',
          "gh api repos/acme/app/pulls/4391/reviews -R acme/app",
        ),
      },
    },
    {
      name: "a read by URL",
      command: "gh pr view https://github.com/acme/app/pull/12 --json state",
      decision: {
        allow: false,
        reason: redirect(
          "status",
          '{"pullRequests":[{"url":"https://github.com/acme/app/pull/12"}]}',
          "gh pr view https://github.com/acme/app/pull/12 --json state",
        ),
      },
    },
    {
      name: "a poll, with no bypass offered",
      command:
        "until gh pr checks 123 --json bucket | jq -e 'all(.bucket!=\"pending\")'; do sleep 60; done",
      decision: { allow: false, reason: POLL_DENIED_REASON },
    },
    {
      name: "a watch, even with the bypass",
      command: "T3_GH_DIRECT=1 gh pr checks 123 --watch",
      decision: { allow: false, reason: POLL_DENIED_REASON },
    },
    {
      name: "a bypassed read",
      command: "T3_GH_DIRECT=1 gh pr checks 123",
      decision: { allow: true },
    },
    { name: "a write", command: "gh pr merge 123 --squash --auto", decision: { allow: true } },
    { name: "a view of the body", command: "gh pr view 123", decision: { allow: true } },
    { name: "a run list", command: "gh run list --workflow ci.yml", decision: { allow: true } },
    { name: "a shell command without gh", command: "git status", decision: { allow: true } },
    { name: "gh only in text", command: "echo 'gh pr checks 123'", decision: { allow: true } },
  ])("decides $name", ({ command, decision }) => {
    assert.deepStrictEqual<unknown>(decideGitHubCommand(command), decision);
  });
});

describe("pullRequestReadArguments", () => {
  it("names the pull request the way the tools take one, or nothing for the current branch", () => {
    assert.deepStrictEqual(pullRequestReadArguments({}), {});
    assert.deepStrictEqual(pullRequestReadArguments({ repository: "acme/app" }), {});
    assert.deepStrictEqual(pullRequestReadArguments({ number: 12 }), {
      pullRequests: [{ number: 12 }],
    });
    assert.deepStrictEqual(pullRequestReadArguments({ repository: "acme/app", number: 12 }), {
      pullRequests: [{ repository: "acme/app", number: 12 }],
    });
    assert.deepStrictEqual(
      pullRequestReadArguments({ url: "https://github.com/acme/app/pull/12", number: 12 }),
      { pullRequests: [{ url: "https://github.com/acme/app/pull/12" }] },
    );
  });
});
