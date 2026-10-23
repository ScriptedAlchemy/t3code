import { describe, expect, it } from "@effect/vitest";

import { recognizeTestCommand } from "./testCommands.ts";

describe("recognizeTestCommand", () => {
  it.each([
    "vp test run apps/server/src/ws.test.ts",
    "cd apps/web && vp test run src/foo.browser.test.tsx 2>&1 | tail -20",
    "npx vitest run",
    "pnpm test",
    "npm run test:unit",
    "bun test",
    "cargo test -p core",
    "cargo nextest run",
    "go test ./...",
    "python3 -m pytest tests",
    "uv run pytest -k loom",
    "CI=1 FORCE_COLOR=0 jest --runInBand",
    "bundle exec rspec spec/models",
    "/bin/bash -lc 'cd /repo && pnpm run test'",
  ])("recognizes %s", (command) => {
    expect(recognizeTestCommand(command)).not.toBeNull();
  });

  it.each([
    "echo test",
    "grep -rn vitest apps/web",
    "cat src/foo.test.ts",
    "ls tests",
    'git commit -m "fix flaky test && vitest run"',
    "npm run testify",
    "npm install vitest",
    "cargo build",
    "python3 - <<'EOF'\nimport subprocess\nvitest run\nEOF",
    "/bin/bash -lc 'rg vitest'",
    "",
  ])("ignores %s", (command) => {
    expect(recognizeTestCommand(command)).toBeNull();
  });

  it("returns the command a shell wrapper ran", () => {
    expect(recognizeTestCommand("/bin/zsh -lc 'go test ./...'")).toBe("go test ./...");
  });
});
