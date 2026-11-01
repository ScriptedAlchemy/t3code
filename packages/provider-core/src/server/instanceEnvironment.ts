import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { expandHomePath } from "./pathExpansion.ts";
import * as ProviderHost from "./ProviderHost.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const next: NodeJS.ProcessEnv = environment?.length ? { ...baseEnv } : baseEnv;
  for (const variable of environment ?? []) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    if (platform === "win32") {
      for (const key of Object.keys(next)) {
        if (key !== variable.name && key.toUpperCase() === variable.name.toUpperCase())
          delete next[key];
      }
    }
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  const host = yield* Effect.serviceOption(ProviderHost.ProviderHost);
  return Option.isSome(host) && host.value.prepareAgentEnvironment !== undefined
    ? yield* host.value.prepareAgentEnvironment(next)
    : next;
});
