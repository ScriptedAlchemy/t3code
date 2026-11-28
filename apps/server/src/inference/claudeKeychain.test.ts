// @effect-diagnostics nodeBuiltinImport:off -- the real macOS Keychain and a unique item name are the fixture.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProcessRunner from "../processRunner.ts";
import { readClaudeKeychain, writeClaudeKeychain } from "./claudeKeychain.ts";

const username = NodeOS.userInfo().username;

it.live.runIf(HostProcess.Platform.defaultValue() === "darwin")(
  "keeps the Claude Code item readable by /usr/bin/security across writes of any size",
  () =>
    Effect.gen(function* () {
      const runner = yield* ProcessRunner.ProcessRunner;
      const service = `t3code-test-${NodeCrypto.randomUUID()}`;
      const security = (...args: Array<string>) =>
        runner.run({ command: "/usr/bin/security", args, timeout: "5 seconds" });
      yield* Effect.addFinalizer(() =>
        security("delete-generic-password", "-a", username, "-s", service).pipe(Effect.ignore),
      );
      expect(yield* readClaudeKeychain(username, service)).toBeUndefined();

      const short = JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: 1 } });
      const long = JSON.stringify({ claudeAiOauth: { accessToken: "b".repeat(5000) } });
      for (const value of [short, long, short]) {
        yield* writeClaudeKeychain(username, value, service);
        // Claude Code's own read; a partition mismatch would block on a Keychain dialog.
        const asClaudeCode = yield* security(
          "find-generic-password",
          "-a",
          username,
          "-s",
          service,
          "-w",
        );
        expect(asClaudeCode).toMatchObject({ code: 0, stdout: `${value}\n` });
        expect(yield* readClaudeKeychain(username, service)).toBe(value);
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
);
