// Programs that only ever run tests.
const TEST_RUNNERS = new Set([
  "vitest",
  "jest",
  "pytest",
  "py.test",
  "mocha",
  "ava",
  "rspec",
  "phpunit",
  "ctest",
  "nextest",
]);

// Tools whose `test` subcommand runs tests: `cargo test`, `go test`, `npm test`.
const TEST_SUBCOMMAND_TOOLS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "vp",
  "go",
  "cargo",
  "mix",
  "mvn",
  "gradle",
  "./gradlew",
  "gradlew",
  "dotnet",
  "swift",
  "make",
  "turbo",
  "nx",
  "playwright",
]);

// Wrappers that run the following program: `npx vitest`, `uv run pytest`, `bundle exec rspec`.
const WRAPPERS: ReadonlyArray<ReadonlyArray<string>> = [
  ["npx"],
  ["bunx"],
  ["pnpx"],
  ["pnpm", "exec"],
  ["pnpm", "dlx"],
  ["yarn", "exec"],
  ["npm", "exec"],
  ["uv", "run"],
  ["poetry", "run"],
  ["pipenv", "run"],
  ["bundle", "exec"],
  ["time"],
  ["env"],
];

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_WRAPPER = /^\s*(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/;
const TEST_SCRIPT = /^test(?:[:\-_].*)?$/;

function basename(program: string): string {
  return program.startsWith("./") ? program : (program.split("/").at(-1) ?? program);
}

function stripPrefix(words: ReadonlyArray<string>): ReadonlyArray<string> {
  let rest = words;
  for (;;) {
    while (rest[0] !== undefined && ENV_ASSIGNMENT.test(rest[0])) rest = rest.slice(1);
    const wrapper = WRAPPERS.find((prefix) => prefix.every((word, index) => rest[index] === word));
    if (wrapper === undefined) return rest;
    rest = rest.slice(wrapper.length);
    // `npx --yes vitest`: skip the wrapper's own flags.
    while (rest[0]?.startsWith("-")) rest = rest.slice(1);
  }
}

function isTestSegment(segment: string): boolean {
  const words = stripPrefix(segment.trim().split(/\s+/).filter(Boolean));
  const program = words[0];
  if (program === undefined) return false;
  const name = basename(program);
  if (name === "python" || name === "python3") {
    return words[1] === "-m" && (words[2] === "pytest" || words[2] === "unittest");
  }
  if (TEST_RUNNERS.has(name)) return true;
  if (!TEST_SUBCOMMAND_TOOLS.has(name)) return false;
  const subcommand = words[1];
  if (subcommand === undefined) return false;
  if (TEST_SCRIPT.test(subcommand)) return true;
  // `npm run test:unit`, `vp run test`, `cargo nextest run`.
  if (subcommand === "run" && words[2] !== undefined) return TEST_SCRIPT.test(words[2]);
  return name === "cargo" && subcommand === "nextest";
}

/**
 * The command text when a shell command runs a test suite, otherwise null. Conservative: it looks
 * only at the program each `&&`, `;` or `|` segment starts, so `echo test` or `grep -r vitest`
 * never match. A match says the command ran tests, not how many passed.
 */
export function recognizeTestCommand(command: string): string | null {
  // Codex wraps commands as `/bin/bash -lc '...'`.
  const wrapped = SHELL_WRAPPER.exec(command);
  if (wrapped?.[2] !== undefined) return recognizeTestCommand(wrapped[2]);
  // Quoted text is an argument, so `git commit -m "a && vitest"` stays a commit. A heredoc
  // body is input, so only the line that starts it is a command.
  const commandLines = command.includes("<<") ? (command.split("\n")[0] ?? "") : command;
  const isTest = commandLines
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "''")
    .split(/&&|\|\||;|\||\n/)
    .some((segment) => isTestSegment(segment.replace(/^\s*[({]\s*/, "")));
  return isTest ? command.trim() : null;
}
