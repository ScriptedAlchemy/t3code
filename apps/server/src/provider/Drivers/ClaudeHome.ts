import type { Settings as ClaudeSdkSettings } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const CLAUDE_BACKEND_ENVIRONMENT = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
] as const;

const CLAUDE_ACCOUNT_ENVIRONMENT = [
  ...CLAUDE_BACKEND_ENVIRONMENT,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_PROFILE",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
] as const;

export function claudeCliEnvironment(environment: NodeJS.ProcessEnv, configDir: string) {
  const next = { ...environment };
  for (const key of Object.keys(next)) {
    const name = key.toUpperCase();
    if (
      name.startsWith("ANTHROPIC_") ||
      CLAUDE_ACCOUNT_ENVIRONMENT.some((entry) => entry === name) ||
      name === "CLAUDE_CONFIG_DIR" ||
      name === "CLAUDE_SECURESTORAGE_CONFIG_DIR"
    ) {
      delete next[key];
    }
  }
  return { ...next, CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir };
}

export function claudeAccountSettings(
  config: Pick<ClaudeSettings, "setupMode" | "homePath">,
): ClaudeSdkSettings | undefined {
  if (config.setupMode !== "cli") return undefined;
  return {
    forceLoginMethod: "claudeai",
    apiKeyHelper: "",
    awsAuthRefresh: "",
    awsCredentialExport: "",
    env: {
      ...Object.fromEntries(CLAUDE_ACCOUNT_ENVIRONMENT.map((key) => [key, ""])),
      ...Object.fromEntries(CLAUDE_BACKEND_ENVIRONMENT.map((key) => [key, "0"])),
      CLAUDE_CONFIG_DIR: config.homePath,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: config.homePath,
    },
  };
}

export interface ClaudeRuntime {
  readonly mode: "existing" | "cli";
  readonly config: ClaudeSettings;
  readonly configDir: string;
  readonly environment: NodeJS.ProcessEnv;
}

export const resolveClaudeRuntime = Effect.fn("resolveClaudeRuntime")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly config: ClaudeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly stateDir: string;
}): Effect.fn.Return<ClaudeRuntime, never, Path.Path> {
  const path = yield* Path.Path;
  const mode = input.config.setupMode ?? "existing";
  const configDir =
    mode === "cli"
      ? path.join(input.stateDir, "providers", "claude", input.instanceId, "cli")
      : yield* resolveClaudeHomePath(input.config, input.environment);
  const config = mode === "cli" ? { ...input.config, homePath: configDir } : input.config;
  const environment =
    mode === "cli"
      ? claudeCliEnvironment(input.environment, configDir)
      : yield* makeClaudeEnvironment(config, input.environment);
  return { mode, config, configDir, environment };
});

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Changing HOME hides macOS Keychain credentials; use CLAUDE_CONFIG_DIR to keep login access.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

/** managed-mcp.json excludes other MCP config and forbids --strict-mcp-config; omit the flag when present. */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/** Separate spawn env from login commands to preserve literal paths, including relative inherited values. */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
