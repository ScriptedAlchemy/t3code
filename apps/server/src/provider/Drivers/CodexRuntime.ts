import type { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { resolveCodexHomeLayout } from "./CodexHomeLayout.ts";

export const codexCliLaunchArgs = (launchArgs: string) =>
  [
    launchArgs,
    ...[
      'cli_auth_credentials_store="file"',
      'model_provider="openai"',
      'chatgpt_base_url="https://chatgpt.com/backend-api/"',
    ].map((value) => `-c '${value}'`),
  ].join(" ");

export const CODEX_CLI_ACCOUNT_ENVIRONMENT = {
  OPENAI_API_KEY: "",
  CODEX_API_KEY: "",
  OPENAI_BASE_URL: "",
  ACCESS_TOKEN: "",
  T3CODE_CODEX_LAUNCH_ARGS: "",
};

export function codexCliEnvironment(environment: NodeJS.ProcessEnv, homePath: string) {
  const next: NodeJS.ProcessEnv = { ...environment };
  for (const key of Object.keys(next)) {
    const name = key.toUpperCase();
    if (name === "CODEX_HOME" || Object.hasOwn(CODEX_CLI_ACCOUNT_ENVIRONMENT, name)) {
      delete next[key];
    }
  }
  return { ...next, CODEX_HOME: homePath };
}

export const resolveCodexRuntime = Effect.fn("resolveCodexRuntime")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly stateDir: string;
}) {
  const path = yield* Path.Path;
  const cliAccount = input.config.setupMode === "cli";
  const homeLayout = yield* resolveCodexHomeLayout(
    cliAccount
      ? {
          ...input.config,
          shadowHomePath: path.join(input.stateDir, "providers", "codex", input.instanceId, "cli"),
        }
      : input.config,
    input.environment,
  );
  const homePath = homeLayout.effectiveHomePath;
  return {
    homeLayout,
    config: {
      ...input.config,
      homePath: homePath ?? "",
      ...(cliAccount ? { launchArgs: codexCliLaunchArgs(input.config.launchArgs) } : {}),
    },
    environment: cliAccount
      ? codexCliEnvironment(input.environment, homePath ?? homeLayout.sharedHomePath)
      : homePath
        ? { ...input.environment, CODEX_HOME: homePath }
        : input.environment,
  };
});
