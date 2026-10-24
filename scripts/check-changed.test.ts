// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import { expect, it, vi } from "vite-plus/test";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: () => true, readdirSync: () => [] }));
vi.mock("../.github/scripts/ci-changes.cjs", () => ({
  readWorkspace: () => [],
  decide: () => ({ affected: [], outputs: {} }),
}));

function setup(file: string, cargoMissing = false, buildFails = false) {
  vi.resetModules();
  const commands: string[][] = [];
  vi.mocked(NodeChildProcess.execFileSync).mockImplementation((_command, args) =>
    args?.[0] === "diff" ? file + "\n" : "",
  );
  vi.mocked(NodeChildProcess.spawnSync).mockImplementation((command, args) => {
    commands.push([String(command), ...(args ?? [])]);
    return {
      pid: 1,
      output: [],
      stdout: "abcdef",
      stderr: "",
      status: command === "cargo" && cargoMissing ? null : command === "node" && buildFails ? 1 : 0,
      signal: null,
      ...(command === "cargo" && cargoMissing
        ? { error: Object.assign(new Error("not found"), { code: "ENOENT" }) }
        : {}),
    };
  });
  return commands;
}

it("builds project-memory before selected server tests", async () => {
  const commands = setup("apps/server/src/Example.test.ts");
  using _log = vi.spyOn(console, "log").mockImplementation(() => {});
  await import("./check-changed.ts");
  const build = commands.findIndex((args) => args.includes("native/project-memory/build.mjs"));
  const test = commands.findIndex(
    (args) => args.includes("apps/server/src/Example.test.ts") && args.includes("test"),
  );
  expect(build).toBeGreaterThan(-1);
  expect(test).toBeGreaterThan(build);
});

it("does not build project-memory for non-server tests", async () => {
  const commands = setup("scripts/example.test.ts");
  using _log = vi.spyOn(console, "log").mockImplementation(() => {});
  await import("./check-changed.ts");
  expect(commands.some((args) => args.includes("native/project-memory/build.mjs"))).toBe(false);
});

it("reports missing cargo and does not run tests without the addon", async () => {
  const commands = setup("apps/server/src/Example.test.ts", true);
  using _log = vi.spyOn(console, "log").mockImplementation(() => {});
  using error = vi.spyOn(console, "error").mockImplementation(() => {});
  using _exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("./check-changed.ts")).rejects.toThrow("exit");
  expect(error).toHaveBeenCalledWith(expect.stringContaining("cargo"));
  expect(commands.some((args) => args.includes("test") && args.includes("run"))).toBe(false);
});

it("does not run server tests when the addon build fails", async () => {
  const commands = setup("apps/server/src/Example.test.ts", false, true);
  using _log = vi.spyOn(console, "log").mockImplementation(() => {});
  using _exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("./check-changed.ts")).rejects.toThrow("exit");
  expect(commands.some((args) => args.includes("native/project-memory/build.mjs"))).toBe(true);
  expect(commands.some((args) => args.includes("test") && args.includes("run"))).toBe(false);
});
