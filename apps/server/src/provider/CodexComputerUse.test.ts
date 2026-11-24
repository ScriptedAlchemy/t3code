import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { stringify } from "smol-toml";

import { resolveCodexComputerUse } from "./CodexComputerUse.ts";
import { configureProviderComputerUse, prepareComputerUseEdits } from "./CodexComputerUseSetup.ts";

const resources = "/custom/Acme.app/Contents/Resources";
const command = `${resources}/cua_node/bin/node_repl`;
const modules = `${resources}/cua_node/lib/node_modules`;
const helper = "/custom-codex-home/computer-use/Codex Computer Use.app";
const skillPath = `${resources}/plugins/openai-bundled/plugins/computer-use/skills/computer-use/SKILL.md`;
const available = { status: "available", skillPath } as const;
const unavailable = { status: "unavailable" } as const;
const configured = () => ({
  features: { plugins: true },
  plugins: { "computer-use@openai-bundled": { enabled: true } },
  mcp_servers: {
    node_repl: {
      enabled: true,
      command,
      env: {
        NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service" }),
        NODE_REPL_NODE_MODULE_DIRS: modules,
        SKY_CUA_SERVICE_PATH: helper,
      },
    },
  },
});
const rpcError = new CodexErrors.CodexAppServerTransportError({
  operation: "write-output-stream",
  cause: "fixture",
});

it("prepares only the native Mac tool for a separate Codex home without replacing its settings", () => {
  const source = configured();
  const node = source.mcp_servers.node_repl;
  const config = {
    ...source,
    mcp_servers: {
      node_repl: {
        ...node,
        args: [],
        environment_id: "local",
        tool_timeout_sec: null,
        env: {
          ...node.env,
          CODEX_HOME: "/personal",
          TOKEN: "private",
          NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service", browser: "other" }),
        },
      },
    },
  };
  const target = { model_provider: "custom", mcp_servers: { unrelated: {} } };
  const edits = prepareComputerUseEdits(config, target);
  assert.deepEqual(
    edits.map((edit) => edit.keyPath),
    ["plugins.computer-use@openai-bundled.enabled", "mcp_servers.node_repl"],
  );
  assert.deepEqual(edits[1]?.value, {
    command,
    enabled_tools: ["js"],
    env: {
      ...node.env,
      NODE_REPL_NODE_PATH: `${resources}/cua_node/bin/node`,
      NODE_REPL_TRUSTED_CODE_PATHS: modules,
    },
  });
  for (const conflict of [
    { features: { plugins: false } },
    { plugins: { "computer-use@openai-bundled": { enabled: false } } },
    { mcp_servers: { node_repl: {} } },
  ]) {
    assert.throws(() => prepareComputerUseEdits(config, conflict));
  }
  assert.throws(() =>
    prepareComputerUseEdits(
      { ...config, mcp_servers: { node_repl: { ...node, disabled_tools: ["js"] } } },
      target,
    ),
  );
});

const fixture = (
  options: {
    config?: unknown;
    layers?: unknown;
    requirements?: unknown;
    skills?: ReadonlyArray<unknown>;
    skillErrors?: ReadonlyArray<unknown>;
    missing?: string;
    fail?: string;
    platform?: NodeJS.Platform;
    homePath?: string;
    nativeConfig?: string;
    request?: CodexClient.CodexAppServerClient["Service"]["raw"]["request"];
  } = {},
) => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const reads: string[] = [];
  const request: CodexClient.CodexAppServerClient["Service"]["raw"]["request"] = (
    method,
    params,
  ) => {
    calls.push({ method, params });
    if (options.request) return options.request(method, params);
    if (options.fail === method) return Effect.fail(rpcError);
    if (method === "config/batchWrite") return Effect.succeed({ status: "ok" });
    if (method === "config/read")
      return Effect.succeed({
        config: options.config ?? configured(),
        origins: {},
        ...(options.layers === undefined ? {} : { layers: options.layers }),
      });
    if (method === "configRequirements/read")
      return Effect.succeed(
        options.requirements === undefined ? {} : { requirements: options.requirements },
      );
    if (method === "skills/list")
      return Effect.succeed({
        data: [
          {
            cwd: options.homePath ? "/" : "/project",
            skills: options.skills ?? [],
            errors: options.skillErrors ?? [],
          },
        ],
      });
    return Effect.die(`Unexpected RPC ${method}`);
  };
  const client = CodexClient.CodexAppServerClient.of({
    raw: {
      request,
      notifications: Stream.empty,
      requests: Stream.empty,
      notify: () => Effect.void,
      respond: () => Effect.void,
      respondError: () => Effect.void,
    },
    request: () => Effect.die("Use the active client's raw discovery boundary"),
    notify: () => Effect.void,
    awaitTermination: Effect.never,
    handleServerRequest: () => Effect.void,
    handleServerNotification: () => Effect.void,
    handleUnknownServerRequest: () => Effect.void,
    handleUnknownServerNotification: () => Effect.void,
  });
  const absent = FileSystem.makeNoop({});
  const fileSystem = FileSystem.makeNoop({
    realPath: (path) => Effect.succeed(path),
    access: (path) =>
      Effect.sync(() => {
        reads.push(path);
      }).pipe(Effect.andThen(path === options.missing ? absent.access(path) : Effect.void)),
    readFileString: (path) => {
      reads.push(path);
      if (path === options.missing) return absent.readFileString(path);
      if (path === "/mac/.codex/config.toml") return Effect.succeed(options.nativeConfig ?? "");
      if (path.endsWith("package.json"))
        return Effect.succeed(
          JSON.stringify({ name: "@oai/sky", exports: { "./service": "./service.js" } }),
        );
      return Effect.succeed(
        "---\nname: computer-use\ndescription: Native Mac UI\n---\nFull installed instructions.",
      );
    },
  });
  const provide = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      CodexClient.CodexAppServerClient | FileSystem.FileSystem | Path.Path
    >,
  ) =>
    effect.pipe(
      Effect.provideService(CodexClient.CodexAppServerClient, client),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provide(Path.layer),
      Effect.provideService(HostProcess.HomeDirectory, "/mac"),
      Effect.provideService(HostProcess.Platform, options.platform ?? "darwin"),
    );
  return {
    resolve: provide(resolveCodexComputerUse({ cwd: "/project" })),
    configure: provide(configureProviderComputerUse(options.homePath)),
    calls,
    reads,
  };
};

it.effect(
  "provisions an isolated provider home globally without replacing overrides or writing from a project layer",
  () =>
    Effect.gen(function* () {
      const file = "/providers/custom/config.toml";
      const user = { name: { type: "user", file }, config: {}, version: "original" };
      const custom = {
        homePath: "/providers/custom",
        config: {},
        layers: [user],
        nativeConfig: stringify(configured()),
      };
      const fresh = fixture(custom);
      yield* fresh.configure;
      assert.deepEqual(
        fresh.calls
          .filter((call) => call.method === "config/batchWrite")
          .map((call) => call.params),
        [
          {
            filePath: file,
            expectedVersion: "original",
            reloadUserConfig: true,
            edits: prepareComputerUseEdits(configured(), {}),
          },
        ],
      );
      for (const overrides of [
        { config: configured() },
        { config: { features: { plugins: false } } },
        { config: { mcp_servers: { node_repl: { enabled: false } } } },
        { requirements: { allowBrowserAndComputerUse: false } },
        {
          layers: [
            user,
            { name: { type: "project", dotCodexFolder: "/.codex" }, config: {}, version: "other" },
          ],
        },
        { nativeConfig: "invalid TOML" },
        { platform: "linux" as const },
      ]) {
        const blocked = fixture({ ...custom, ...overrides });
        yield* blocked.configure;
        assert.isFalse(blocked.calls.some((call) => call.method === "config/batchWrite"));
      }
    }),
);

it.effect("locates configured native files from the selected effective home and cwd", () =>
  Effect.gen(function* () {
    const f = fixture();
    assert.deepEqual(yield* f.resolve, available);
    assert.deepEqual(
      f.calls.map((c) => c.method),
      ["config/read", "configRequirements/read", "skills/list"],
    );
    assert.deepEqual(f.calls[0]?.params, { cwd: "/project", includeLayers: false });
    assert.deepEqual(f.calls[2]?.params, { cwds: ["/project"] });
    assert.include(f.reads, `${helper}/Contents/MacOS/SkyComputerUseService`);
    assert.isFalse(f.reads.some((path) => path.startsWith("/Users/")));
  }),
);

it.effect.each(["linux", "win32"] as const)("does no I/O on %s", (platform) =>
  Effect.gen(function* () {
    const f = fixture({ platform });
    assert.deepEqual(yield* f.resolve, unavailable);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.reads, []);
  }),
);

it.effect.each([
  [
    "effective plugin disabled",
    () => ({ ...configured(), plugins: { "computer-use@openai-bundled": { enabled: false } } }),
  ],
  ["plugins feature disabled", () => ({ ...configured(), features: { plugins: false } })],
  ["plugin missing", () => ({ ...configured(), plugins: {} })],
  [
    "node server disabled",
    () => {
      const c = configured();
      c.mcp_servers.node_repl.enabled = false;
      return c;
    },
  ],
  [
    "generic node repl",
    () => {
      const c = configured();
      c.mcp_servers.node_repl.env.NODE_REPL_TRUSTED_SERVICES = "{}";
      return c;
    },
  ],
  [
    "untrusted sky registration",
    () => {
      const c = configured();
      c.mcp_servers.node_repl.env.NODE_REPL_TRUSTED_SERVICES = '{"sky":"other/service"}';
      return c;
    },
  ],
  [
    "malformed services",
    () => {
      const c = configured();
      c.mcp_servers.node_repl.env.NODE_REPL_TRUSTED_SERVICES = "{";
      return c;
    },
  ],
  [
    "unmatched module directory",
    () => {
      const c = configured();
      c.mcp_servers.node_repl.env.NODE_REPL_NODE_MODULE_DIRS = "/other/node_modules";
      return c;
    },
  ],
  [
    "relative command",
    () => {
      const c = configured();
      c.mcp_servers.node_repl.command = "node_repl";
      return c;
    },
  ],
  [
    "skill name disabled",
    () => ({ ...configured(), skills: { config: [{ name: "computer-use", enabled: false }] } }),
  ],
  [
    "qualified skill disabled",
    () => ({
      ...configured(),
      skills: { config: [{ name: "computer-use:computer-use", enabled: false }] },
    }),
  ],
  [
    "skill path disabled",
    () => ({ ...configured(), skills: { config: [{ path: skillPath, enabled: false }] } }),
  ],
] as const)("respects %s", ([_name, config]) =>
  Effect.gen(function* () {
    assert.deepEqual(yield* fixture({ config: config() }).resolve, unavailable);
  }),
);

it.effect.each([
  ["empty allowlist", { enabled_tools: [] }, unavailable],
  ["allowlist without js", { enabled_tools: ["reset"] }, unavailable],
  ["js denied", { disabled_tools: ["js"] }, unavailable],
  ["denylist takes precedence", { enabled_tools: ["js"], disabled_tools: ["js"] }, unavailable],
  ["js allowed", { enabled_tools: ["js"] }, available],
  ["unrelated tool denied", { disabled_tools: ["reset"] }, available],
] as const)("respects node tool selection: %s", ([_name, selection, expected]) =>
  Effect.gen(function* () {
    const config = configured();
    config.mcp_servers.node_repl = { ...config.mcp_servers.node_repl, ...selection };
    assert.deepEqual(yield* fixture({ config }).resolve, expected);
  }),
);

it.effect("uses effective project disablement even when the user layer enables the plugin", () =>
  Effect.gen(function* () {
    const config = configured();
    config.plugins["computer-use@openai-bundled"].enabled = false;
    const f = fixture({
      config,
      layers: [
        { name: { type: "project", dotCodexFolder: "/project/.codex" }, config },
        { name: { type: "user", file: "/custom-codex-home/config.toml" }, config: configured() },
      ],
    });
    assert.deepEqual(yield* f.resolve, unavailable);
    assert.deepEqual(f.calls[0]?.params, { cwd: "/project", includeLayers: false });
  }),
);

it.effect.each([
  { allowBrowserAndComputerUse: false },
  { computerUse: { allowedApps: [] } },
  { computerUse: { futureRestriction: true } },
  { featureRequirements: { plugins: false } },
])("does not substitute for administrator requirements %j", (requirements) =>
  Effect.gen(function* () {
    assert.deepEqual(yield* fixture({ requirements }).resolve, unavailable);
  }),
);

it.effect.each([
  command,
  `${helper}/Contents/MacOS/SkyComputerUseService`,
  skillPath,
  `${modules}/@oai/sky/package.json`,
  `${modules}/@oai/sky/service.js`,
])("requires readable native component %s", (missing) =>
  Effect.gen(function* () {
    assert.deepEqual(yield* fixture({ missing }).resolve, unavailable);
  }),
);

it.effect(
  "prefers an enabled discovered copy and lets a disabled copy veto the bundle fallback",
  () =>
    Effect.gen(function* () {
      const path = "/custom-codex-home/plugins/cache/computer-use/skills/computer-use/SKILL.md";
      const skill = {
        name: "computer-use:computer-use",
        path,
        enabled: true,
        pluginId: "computer-use@openai-bundled",
      };
      assert.deepEqual(
        yield* fixture({ skills: [{ ...skill, pluginId: null, scope: "repo" }] }).resolve,
        available,
      );
      assert.deepEqual(
        yield* fixture({
          skillErrors: [{ path: "/project/.agents/skills/other/SKILL.md", message: "invalid" }],
        }).resolve,
        available,
      );
      assert.deepEqual(
        yield* fixture({ skillErrors: [{ path: skillPath, message: "invalid" }] }).resolve,
        unavailable,
      );
      assert.deepEqual(yield* fixture({ skills: [skill] }).resolve, {
        status: "available",
        skillPath: path,
      });
      assert.deepEqual(
        yield* fixture({ skills: [skill, { ...skill, path: skillPath, enabled: false }] }).resolve,
        unavailable,
      );
    }),
);

it.effect.each(["config/read", "configRequirements/read", "skills/list"])(
  "isolates optional %s errors",
  (fail) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* fixture({ fail }).resolve, unavailable);
    }),
);

it.effect("re-evaluates project disablement on every turn", () =>
  Effect.gen(function* () {
    const config = configured();
    const f = fixture({ config });
    assert.deepEqual(yield* f.resolve, available);
    config.plugins["computer-use@openai-bundled"].enabled = false;
    assert.deepEqual(yield* f.resolve, unavailable);
    assert.equal(f.calls.filter((c) => c.method === "config/read").length, 2);
  }),
);

it.effect("bounds discovery to two seconds and preserves caller interruption", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const f = fixture({
      request: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const fiber = yield* Effect.forkChild(f.resolve);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("2 seconds");
    assert.deepEqual(yield* Fiber.join(fiber), unavailable);
    const enteredAgain = yield* Deferred.make<void>();
    const second = fixture({
      request: () => Deferred.succeed(enteredAgain, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const interrupted = yield* Effect.forkChild(second.resolve);
    yield* Deferred.await(enteredAgain);
    yield* Fiber.interrupt(interrupted);
    const exit = yield* Fiber.await(interrupted);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
  }),
);
