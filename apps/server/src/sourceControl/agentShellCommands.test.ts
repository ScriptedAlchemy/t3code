import { assert, describe, it } from "@effect/vitest";

import { agentShellCommands, classifyAgentShellCommands } from "./agentShellCommands.ts";

const status = (target: Record<string, unknown>, bypass = false) => ({
  forge: "github",
  command: { kind: "read", intent: "status", target },
  bypass,
});
const poll = { forge: "github", command: { kind: "poll" }, bypass: false };

describe("classifyAgentShellCommands", () => {
  it.each([
    { name: "a plain read", input: "gh pr checks 4497", expected: [status({ number: 4497 })] },
    {
      name: "a Codex shell wrapper with a pipeline",
      input: "/bin/zsh -lc \"gh pr checks 4497 2>&1 | awk -F'\\t' '{print $2}' | sort\"",
      expected: [status({ number: 4497 })],
    },
    {
      name: "a cd and an environment prefix",
      input: "cd /work/app && GH_PAGER= timeout 60 gh pr checks 4496 --json bucket",
      expected: [status({ number: 4496 })],
    },
    {
      name: "the bypass prefix, also through env",
      input: "T3_GH_DIRECT=1 gh pr checks 4497; env T3_GH_DIRECT=1 gh pr checks 4498",
      expected: [status({ number: 4497 }, true), status({ number: 4498 }, true)],
    },
    {
      name: "an until loop that sleeps",
      input:
        "until gh pr checks 4497 --json bucket 2>/dev/null | jq -e 'all(.bucket!=\"pending\")' >/dev/null; do sleep 60; done; gh pr checks 4497 2>&1 | awk -F'\\t' '{print $2}'",
      expected: [poll, poll],
    },
    {
      name: "a while loop",
      input: "while ! gh pr checks 12 --required; do sleep 30; done",
      expected: [poll],
    },
    {
      name: "a read behind watch",
      input: "watch -n 30 gh pr checks 12",
      expected: [poll],
    },
    {
      name: "a read inside a command substitution",
      input: 'HEAD=$(gh pr view 12 --json headRefOid -q .headRefOid); echo "$HEAD"',
      expected: [status({ number: 12 })],
    },
    {
      name: "the absolute path to gh",
      input: "/opt/homebrew/bin/gh pr checks 12",
      expected: [status({ number: 12 })],
    },
    {
      name: "gh named only in text",
      input:
        "cat > notes.md <<'EOF'\nRun gh pr checks 12 later.\nEOF\necho 'gh pr checks 12' # gh pr checks 12",
      expected: [],
    },
    {
      name: "a write beside a read",
      input: "gh pr merge 12 --squash && gh pr view 12 --json state",
      expected: [
        { forge: "github", command: { kind: "write" }, bypass: false },
        status({ number: 12 }),
      ],
    },
    { name: "no forge command", input: "git status && vp test run", expected: [] },
  ])("classifies $name", ({ input, expected }) => {
    assert.deepStrictEqual<unknown>(classifyAgentShellCommands(input), expected);
  });
});

describe("agentShellCommands", () => {
  it("resolves quotes and drops redirections, keeping the words gh sees", () => {
    assert.deepStrictEqual(
      agentShellCommands(
        `gh api 'repos/acme/app/pulls/$n/comments' --jq ".[] | .body" > out.json 2>&1`,
      ),
      [
        {
          words: ["gh", "api", "repos/acme/app/pulls/$n/comments", "--jq", ".[] | .body"],
          assignments: new Map(),
          repeats: false,
        },
      ],
    );
  });
});
