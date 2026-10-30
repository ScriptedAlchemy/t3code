import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeRuntime,
  materializeClaudeHome,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
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

    for (const shareProfile of [true, false]) {
      it.effect.skipIf(!symlinksSupported)(
        `keeps private accounts separate with shareProfile=${shareProfile}`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
            const shared = path.join(root, "shared");
            const runtime = yield* resolveClaudeRuntime({
              instanceId: ProviderInstanceId.make("private"),
              stateDir: root,
              config: decodeClaudeSettings({
                setupMode: "cli",
                homePath: "/ignored",
                shareProfile,
              }),
              environment: {
                CLAUDE_CONFIG_DIR: shared,
                ANTHROPIC_API_KEY: "host",
                CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
              },
            });
            const accountDir = path.join(root, "providers", "claude", "private", "cli");
            expect(runtime.config.homePath).toBe(accountDir);
            expect(runtime.environment).toEqual({
              CLAUDE_CONFIG_DIR: accountDir,
              CLAUDE_SECURESTORAGE_CONFIG_DIR: accountDir,
            });
            expect(yield* makeClaudeContinuationGroupKey(runtime.config, runtime.environment)).toBe(
              `claude:home:${accountDir}`,
            );
            expect(runtime.overlay).toMatchObject({
              sharedRoot: shared,
              accountDir,
              active: shareProfile,
            });
            const bucket =
              "11111111-1111-1111-1111-111111111111_22222222-2222-2222-2222-222222222222";
            for (const name of ["plugins", "skills"]) {
              yield* fs.makeDirectory(path.join(accountDir, name, "synced", bucket), {
                recursive: true,
              });
              yield* fs.writeFileString(
                path.join(accountDir, name, "synced", bucket, "skill.md"),
                "skill",
              );
              yield* fs.writeFileString(
                path.join(accountDir, name, "synced", `.bucket-${bucket}`),
                "marker",
              );
            }
            yield* materializeClaudeHome(runtime);
            if (shareProfile) {
              for (const name of [
                "plugins",
                "skills",
                "agents",
                "commands",
                "output-styles",
                "rules",
                "hooks",
                "settings.json",
                "CLAUDE.md",
                "keybindings.json",
              ]) {
                expect(yield* fs.readLink(path.join(accountDir, name))).toBe(
                  path.join(shared, name),
                );
              }
              expect(yield* fs.exists(path.join(shared, "settings.json"))).toBe(false);
              for (const name of ["plugins", "skills"]) {
                expect(
                  yield* fs.readFileString(path.join(shared, name, "synced", bucket, "skill.md")),
                ).toBe("skill");
                expect(
                  yield* fs.readFileString(path.join(shared, name, "synced", `.bucket-${bucket}`)),
                ).toBe("marker");
              }
              if (runtime.mode !== "cli") throw new Error("Expected CLI runtime");
              yield* materializeClaudeHome({
                ...runtime,
                overlay: { ...runtime.overlay, active: false },
              });
              expect(yield* fs.readDirectory(accountDir)).toEqual([]);
            }
            expect(yield* fs.exists(path.join(accountDir, "projects"))).toBe(false);
            expect(yield* fs.readDirectory(accountDir)).toEqual(
              shareProfile ? [] : ["plugins", "skills"],
            );
          }),
      );
    }

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
