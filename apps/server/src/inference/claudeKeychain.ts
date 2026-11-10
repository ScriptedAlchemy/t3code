import * as NodeModule from "node:module";

export function claudeKeychainEntry(username: string) {
  const { AsyncEntry } = NodeModule.createRequire(import.meta.url)(
    "@napi-rs/keyring",
  ) as typeof import("@napi-rs/keyring");
  return new AsyncEntry("Claude Code-credentials", username);
}
