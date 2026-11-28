import * as HostProcess from "@t3tools/shared/HostProcess";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse } from "smol-toml";
import { computerUseSkillDisabled, resolveCodexComputerUse } from "./CodexComputerUse.ts";

const plugin = "computer-use@openai-bundled";
const isTable = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const table = (value: unknown) => (isTable(value) ? value : {});

const hasProviderChoice = (config: Record<string, unknown>) =>
  Object.hasOwn(table(config.plugins), plugin) ||
  Object.hasOwn(table(config.mcp_servers), "node_repl") ||
  table(config.features).plugins === false ||
  computerUseSkillDisabled(config);

export function prepareComputerUseEdits(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
) {
  if (hasProviderChoice(target)) {
    throw new Error(
      "The destination already configures the Computer Use plugin or node_repl, or disables plugins. No settings were replaced.",
    );
  }
  const node = table(table(source.mcp_servers).node_repl);
  const env = table(node.env);
  if (
    table(source.features).plugins === false ||
    source.profile != null ||
    computerUseSkillDisabled(source) ||
    table(table(source.plugins)[plugin]).enabled !== true ||
    node.enabled === false ||
    (node.args != null && !(Array.isArray(node.args) && node.args.length === 0)) ||
    (node.environment_id != null && node.environment_id !== "local") ||
    (node.enabled_tools !== undefined &&
      !(Array.isArray(node.enabled_tools) && node.enabled_tools.includes("js"))) ||
    (node.disabled_tools !== undefined &&
      !(Array.isArray(node.disabled_tools) && !node.disabled_tools.includes("js"))) ||
    Object.keys(node).some(
      (key) =>
        ![
          "command",
          "args",
          "environment_id",
          "tool_timeout_sec",
          "env",
          "env_vars",
          "startup_timeout_sec",
          "enabled",
          "enabled_tools",
          "disabled_tools",
        ].includes(key),
    ) ||
    Object.keys(table(source.computer_use)).length > 0 ||
    typeof node.command !== "string" ||
    !node.command.startsWith("/") ||
    !node.command.endsWith("/Contents/Resources/cua_node/bin/node_repl") ||
    typeof env.SKY_CUA_SERVICE_PATH !== "string" ||
    typeof env.NODE_REPL_NODE_MODULE_DIRS !== "string" ||
    typeof env.NODE_REPL_TRUSTED_SERVICES !== "string" ||
    table(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES)).sky !== "@oai/sky/service"
  ) {
    throw new Error(
      "The source is not a supported native Computer Use configuration. No settings were copied.",
    );
  }
  const server = {
    command: node.command,
    enabled_tools: ["js"],
    ...(typeof node.tool_timeout_sec === "number"
      ? { tool_timeout_sec: node.tool_timeout_sec }
      : {}),
    ...(typeof node.startup_timeout_sec === "number"
      ? { startup_timeout_sec: node.startup_timeout_sec }
      : {}),
    env: {
      NODE_REPL_NODE_PATH: node.command.slice(0, -"node_repl".length) + "node",
      NODE_REPL_NODE_MODULE_DIRS: env.NODE_REPL_NODE_MODULE_DIRS,
      NODE_REPL_TRUSTED_CODE_PATHS: env.NODE_REPL_NODE_MODULE_DIRS,
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service" }),
      SKY_CUA_SERVICE_PATH: env.SKY_CUA_SERVICE_PATH,
      ...(typeof env.NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE === "string"
        ? {
            NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE:
              env.NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE,
          }
        : {}),
    },
  };
  return [
    { keyPath: `plugins.${plugin}.enabled`, mergeStrategy: "replace", value: true },
    { keyPath: "mcp_servers.node_repl", mergeStrategy: "replace", value: server },
  ] as const;
}

export const configureProviderComputerUse = Effect.fn("CodexComputerUse.configureProvider")(
  function* (homePath: string | undefined) {
    if (!homePath || (yield* HostProcess.Platform) !== "darwin") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const nativeHome = path.join(yield* HostProcess.HomeDirectory, ".codex");
    if (path.resolve(homePath) === nativeHome) return;
    const target = yield* fs.realPath(homePath);
    if (target === (yield* fs.realPath(nativeHome))) return;
    const configPath = path.join(target, "config.toml");
    const entry = yield* fs
      .lstat(configPath)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
    if (entry && entry.type !== "File") return;
    const client = yield* CodexClient.CodexAppServerClient;
    const { config, layers } = yield* client.raw
      .request("config/read", { cwd: "/", includeLayers: true })
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(CodexSchema.V2ConfigReadResponse)));
    if (
      hasProviderChoice(config) ||
      layers?.some((layer) => layer.name.type === "project" && !layer.disabledReason)
    )
      return;
    const user = layers?.find(
      (layer) =>
        layer.name.type === "user" &&
        !layer.name.profile &&
        layer.name.file === configPath &&
        !layer.disabledReason,
    );
    if (!user || hasProviderChoice(table(user.config))) return;
    const source = yield* fs.readFileString(path.join(nativeHome, "config.toml"));
    const edits = yield* Effect.try({
      try: () => prepareComputerUseEdits(parse(source), config),
      catch: () => "UnsupportedNativeComputerUseConfig" as const,
    });
    const candidateConfig = {
      ...config,
      plugins: { ...table(config.plugins), [plugin]: { enabled: true } },
      mcp_servers: { ...table(config.mcp_servers), node_repl: edits[1].value },
    };
    const checked = yield* resolveCodexComputerUse({ cwd: "/", candidateConfig });
    if (checked.status !== "available") return;
    yield* client.raw.request("config/batchWrite", {
      filePath: configPath,
      expectedVersion: user.version,
      reloadUserConfig: true,
      edits,
    });
    yield* Effect.logDebug("Applied native Computer Use settings to the Codex provider home.");
  },
  Effect.timeout("3 seconds"),
  Effect.catch((reason) =>
    Effect.logDebug("Native Computer Use setup was unavailable.", {
      reason: typeof reason === "string" ? reason : reason._tag,
    }),
  ),
);
