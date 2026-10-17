import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";

import {
  claudeSignedOutMessage,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
  resolveClaudeRuntime,
  claudeAccountSettings,
  claudeCliEnvironment,
} from "./ClaudeHome.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("keeps private accounts separate from each other and the existing profile", () =>
      Effect.gen(function* () {
        const environment = {
          HOME: "/real-home",
          CLAUDE_CONFIG_DIR: "/existing",
          CLAUDE_SECURESTORAGE_CONFIG_DIR: "/existing-keychain",
          ANTHROPIC_API_KEY: "host-key",
          CLAUDE_CODE_OAUTH_TOKEN: "host-token",
          CLAUDE_CODE_USE_BEDROCK: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          HTTPS_PROXY: "http://proxy:8080",
        };
        const resolve = (id: string, setupMode?: "cli") =>
          resolveClaudeRuntime({
            instanceId: ProviderInstanceId.make(id),
            config: decodeClaudeSettings(setupMode ? { setupMode } : {}),
            environment,
            stateDir: "/state",
          });
        const first = yield* resolve("first", "cli");
        const second = yield* resolve("second", "cli");
        const existing = yield* resolve("existing");
        expect([first.configDir, second.configDir, existing.configDir]).toEqual([
          "/state/providers/claude/first/cli",
          "/state/providers/claude/second/cli",
          "/existing",
        ]);
        expect(first.environment).toEqual({
          HOME: "/real-home",
          CLAUDE_CONFIG_DIR: "/state/providers/claude/first/cli",
          CLAUDE_SECURESTORAGE_CONFIG_DIR: "/state/providers/claude/first/cli",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          HTTPS_PROXY: "http://proxy:8080",
        });
        expect(existing.environment).toEqual(environment);
        expect(
          claudeCliEnvironment({ ...environment, ...first.environment }, first.configDir),
        ).toEqual(first.environment);
        expect(claudeAccountSettings(first.config)).toMatchObject({
          forceLoginMethod: "claudeai",
          apiKeyHelper: "",
          env: {
            CLAUDE_CONFIG_DIR: "/state/providers/claude/first/cli",
            CLAUDE_SECURESTORAGE_CONFIG_DIR: "/state/providers/claude/first/cli",
            ANTHROPIC_API_KEY: "",
            CLAUDE_CODE_OAUTH_TOKEN: "",
            CLAUDE_CODE_USE_BEDROCK: "0",
          },
        });
      }),
    );
    it.effect("treats empty, ~/.claude, and the expanded default as the same Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude"));

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: resolved })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);

        const key = `claude:home:${resolved}`;
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "~/.claude" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: resolved })).toBe(key);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });
});
