import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import type { ExternalHistoryError } from "@t3tools/contracts";
import { piHome, resolvePiSessionsDir } from "@t3tools/provider-pi/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveClaudeRuntime } from "../../provider/Drivers/ClaudeHome.ts";
import type { LocalHistoryStore, ThreadCache } from "./LocalHistoryStore.ts";

interface Profile {
  readonly instanceId: ProviderInstanceId;
  readonly config: unknown;
  readonly environment: NodeJS.ProcessEnv;
  readonly stateDir: string;
}

type StoreFactory = (
  root: string,
  cache: ThreadCache,
) => Effect.Effect<LocalHistoryStore, ExternalHistoryError, FileSystem.FileSystem | Path.Path>;
type HistorySupport = { readonly label: string } & (
  | { readonly kind: "native" }
  | {
      readonly kind: "local";
      readonly roots: (
        profile: Profile,
      ) => Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path>;
      readonly open: StoreFactory;
    }
  | { readonly kind: "unsupported"; readonly reason: string }
);

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const unsupported = (label: string): HistorySupport => ({
  kind: "unsupported",
  label,
  reason: "History isn't stored on this machine in a readable format yet.",
});

export function makeHistorySupport(stores: {
  readonly claudeAgent: StoreFactory;
  readonly pi: StoreFactory;
  readonly opencode: StoreFactory;
  readonly openCodeRoots: (
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path>;
}): Readonly<Record<string, HistorySupport>> {
  return {
    codex: { kind: "native", label: "Codex" },
    claudeAgent: {
      kind: "local",
      label: "Claude Code",
      open: stores.claudeAgent,
      roots: Effect.fn("ExternalHistory.claudeRoots")(function* (profile) {
        const config = decodeClaudeSettings(profile.config ?? {});
        if (Option.isNone(config)) return [];
        const runtime = yield* resolveClaudeRuntime({
          ...profile,
          config: config.value,
        });
        return [runtime.configDir];
      }),
    },
    pi: {
      kind: "local",
      label: "Pi",
      open: stores.pi,
      roots: Effect.fn("ExternalHistory.piRoots")(function* ({ environment }) {
        const path = yield* Path.Path;
        const home = yield* HostProcess.HomeDirectory;
        const platform = yield* HostProcess.Platform;
        return [resolvePiSessionsDir(environment, piHome(environment, home, platform), path)];
      }),
    },
    opencode: {
      kind: "local",
      label: "OpenCode",
      open: stores.opencode,
      roots: (profile) => stores.openCodeRoots(profile.environment),
    },
    grok: unsupported("Grok"),
    antigravity: unsupported("Antigravity"),
    cursor: unsupported("Cursor"),
    kiro: unsupported("Kiro"),
    muse: unsupported("Muse"),
    fx: unsupported("FX"),
    acpRegistry: unsupported("ACP agents"),
  };
}
