// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeStream from "node:stream";
import { expect, it, vi } from "vite-plus/test";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: () => true,
  readdirSync: () => [],
  statSync: () => undefined,
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));
vi.mock("../.github/scripts/ci-changes.cjs", () => ({
  readWorkspace: () => [],
  decide: () => ({ affected: [], outputs: {} }),
}));

function setup(files: string[], options: { cargoMissing?: boolean; buildFails?: boolean } = {}) {
  vi.resetModules();
  const events: string[][] = [];
  vi.mocked(NodeFS.readFileSync).mockImplementation((path) => {
    if (String(path).endsWith("package.json")) {
      return JSON.stringify({ scripts: { "knip:check": "knip --include files" } });
    }
    throw new Error("ENOENT");
  });
  vi.mocked(NodeChildProcess.execFileSync).mockImplementation((_command, args) =>
    args?.includes("diff") ? files.join("\n") + "\n" : "",
  );
  vi.mocked(NodeChildProcess.spawnSync).mockImplementation((command, args) => {
    events.push(["spawn", String(command), ...(args ?? [])]);
    return {
      pid: 1,
      output: [],
      stdout: "abcdef",
      stderr: "",
      status: command === "cargo" && options.cargoMissing ? null : 0,
      signal: null,
      ...(command === "cargo" && options.cargoMissing
        ? { error: Object.assign(new Error("not found"), { code: "ENOENT" }) }
        : {}),
    };
  });
  vi.mocked(NodeChildProcess.spawn).mockImplementation((command, args) => {
    const arguments_ = Array.isArray(args) ? args : [];
    events.push(["spawn", command, ...arguments_]);
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdout: new NodeStream.PassThrough(),
      stderr: new NodeStream.PassThrough(),
      stdin: new NodeStream.PassThrough(),
    }) as unknown as NodeChildProcess.ChildProcessWithoutNullStreams;
    queueMicrotask(() => {
      events.push(["close", command, ...arguments_]);
      child.emit("close", command === process.execPath && options.buildFails ? 1 : 0);
    });
    return child;
  });
  return events;
}

const addon = "native/project-memory/build.mjs";
const serverTest = "apps/server/src/Example.test.ts";
const nativeTest = "native/project-memory/kernel.test.mjs";

it("builds once before both server and native tests while other checks run independently", async () => {
  const events = setup([serverTest, nativeTest]);
  using _log = vi.spyOn(console, "log").mockImplementation(() => {});
  await import("./check-changed.ts");
  const builds = events.filter((event) => event[0] === "spawn" && event.includes(addon));
  expect(builds).toHaveLength(1);
  const built = events.findIndex((event) => event[0] === "close" && event.includes(addon));
  for (const test of [serverTest, nativeTest]) {
    const started = events.findIndex(
      (event) =>
        event[0] === "spawn" &&
        event.includes(test) &&
        (event.includes("test") || event.includes("--test")),
    );
    expect(started).toBeGreaterThan(built);
  }
  const format = events.findIndex((event) => event[0] === "spawn" && event.includes("fmt"));
  expect(format).toBeLessThan(built);
});

it("builds the addon for native-only test changes", async () => {
  const events = setup([nativeTest]);
  using _log = vi.spyOn(console, "log").mockImplementation(() => {});
  await import("./check-changed.ts");
  const built = events.findIndex((event) => event[0] === "close" && event.includes(addon));
  const test = events.findIndex((event) => event[0] === "spawn" && event.includes("--test"));
  expect(built).toBeGreaterThan(-1);
  expect(test).toBeGreaterThan(built);
});

it("does not build project-memory for unrelated tests", async () => {
  const events = setup(["scripts/example.test.ts"]);
  using _log = vi.spyOn(console, "log").mockImplementation(() => {});
  await import("./check-changed.ts");
  expect(events.some((event) => event.includes(addon))).toBe(false);
});

it("serial mode waits for each check before starting the next", async () => {
  const events = setup([serverTest, nativeTest]);
  using _log = vi.spyOn(console, "log").mockImplementation(() => {});
  const previousArgv = process.argv;
  process.argv = [process.execPath, "scripts/check-changed.ts", "--serial"];
  try {
    await import("./check-changed.ts");
    const processes = events.filter((event) => event[1] !== "git" && event[1] !== "cargo");
    expect(processes.length).toBeGreaterThan(4);
    for (let index = 0; index < processes.length; index += 2) {
      expect(processes[index]?.[0]).toBe("spawn");
      expect(processes[index + 1]).toEqual(["close", ...processes[index]!.slice(1)]);
    }
  } finally {
    process.argv = previousArgv;
  }
});

it.each(["cargoMissing", "buildFails"] as const)(
  "reports %s without running addon-dependent tests or suppressing other checks",
  async (failure) => {
    const events = setup([serverTest, nativeTest], { [failure]: true });
    using _log = vi.spyOn(console, "log").mockImplementation(() => {});
    using error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await import("./check-changed.ts");
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalled();
      expect(
        events.some(
          (event) => event.includes("--test") || (event.includes("test") && event.includes("run")),
        ),
      ).toBe(false);
      expect(events.some((event) => event.includes("fmt"))).toBe(true);
    } finally {
      process.exitCode = previousExitCode;
    }
  },
);
