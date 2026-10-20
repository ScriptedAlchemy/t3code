import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { claudeAccountSettings, type ClaudeRuntime } from "./Drivers/ClaudeHome.ts";

const ClaudeAuthStatus = Schema.Struct({
  loggedIn: Schema.Boolean,
  authMethod: Schema.String,
  apiProvider: Schema.String,
});
const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeAuthStatus));
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isSetupError = Schema.is(ProviderSetupError);
const MAX_AUTH_OUTPUT = 65_536;

export const makeClaudeCliAuth = Effect.fn("makeClaudeCliAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly runtime: ClaudeRuntime;
  readonly timeoutMs?: number;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const { runtime, instanceId } = options;
  const settings = encodeSettings(claudeAccountSettings(runtime.config));
  const spawn = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    yield* fileSystem.makeDirectory(runtime.configDir, { recursive: true, mode: 0o700 });
    const environment = { ...runtime.environment, BROWSER: "false" };
    const command = yield* resolveSpawnCommand(
      runtime.config.binaryPath,
      ["--settings", settings, ...args],
      { env: environment },
    );
    return yield* spawner.spawn(
      ChildProcess.make(command.command, command.args, {
        cwd: runtime.configDir,
        env: environment,
        extendEnv: false,
        shell: command.shell,
        stdin: "pipe",
        forceKillAfter: "2 seconds",
      }),
    );
  });
  const readStatus = Effect.gen(function* () {
    const child = yield* spawn(["auth", "status", "--json"]);
    let output = "";
    const [exitCode] = yield* Effect.all(
      [
        child.exitCode,
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              if (output.length + chunk.length > MAX_AUTH_OUTPUT)
                throw new Error("Status output exceeded limit");
              output += chunk;
            }),
          ),
        ),
        child.stderr.pipe(Stream.runDrain),
      ],
      { concurrency: "unbounded" },
    );
    const status = yield* decodeStatus(output);
    if (exitCode !== 0 && !(exitCode === 1 && !status.loggedIn && status.authMethod === "none")) {
      return yield* new ProviderSetupError({
        instanceId,
        operation: "start",
        detail: "Claude could not verify the account. Try again.",
      });
    }
    return status;
  }).pipe(Effect.scoped);

  return yield* ProviderAuthFlow.make({
    instanceId,
    credentialBinding: { owner: "provider", key: runtime.configDir },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    defaultMethodId: "browser",
    methods: Effect.succeed([
      {
        id: "browser",
        name: "Sign in with Claude Code",
        description: "Sign in in your browser, then paste the code here.",
        type: "agent",
      },
    ]),
    authenticate: Effect.fn("ClaudeCliAuth.authenticate")(
      function* (_methodId, context) {
        const child = yield* spawn(["auth", "login", "--claudeai"]);
        let offered = false;
        let submitted = false;
        const complete = Effect.fn("ClaudeCliAuth.complete")(function* (code: string) {
          const value = code.trim();
          if (submitted || value.length === 0 || value.length > 4096 || /[\r\n\0]/.test(code)) {
            return yield* new ProviderSetupError({
              instanceId,
              operation: "complete",
              detail: submitted
                ? "A sign-in code was already submitted."
                : "Paste the single-line code from Claude.",
            });
          }
          submitted = true;
          yield* Stream.make(new TextEncoder().encode(`${value}\n`)).pipe(
            Stream.run(child.stdin),
            Effect.mapError(
              () =>
                new ProviderSetupError({
                  instanceId,
                  operation: "complete",
                  detail: "Claude could not accept the code. Start sign-in again.",
                }),
            ),
          );
        });
        const watch = (stream: typeof child.stdout) => {
          let pending = "";
          return stream.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                if (offered) return;
                if (pending.length + chunk.length > MAX_AUTH_OUTPUT) {
                  return yield* new ProviderSetupError({
                    instanceId,
                    operation: "start",
                    detail: "Claude did not provide a sign-in link. Try again.",
                  });
                }
                pending += chunk;
                const match =
                  // oxlint-disable-next-line no-control-regex -- ANSI escapes delimit the CLI's colored browser link.
                  /https:\/\/(?:claude\.com|claude\.ai)\/(?:cai\/)?oauth\/authorize\?[^\s\u001b]+(?=[\s\u001b])/.exec(
                    pending,
                  );
                if (!match) return;
                const url = new URL(match[0]);
                if (
                  url.username ||
                  url.password ||
                  url.port ||
                  url.hash ||
                  match[0].length > 16_384
                )
                  return;
                offered = true;
                yield* context.setInteraction(
                  {
                    type: "browser",
                    id: context.flowId,
                    url: url.toString(),
                    requiresConsent: false,
                    acceptsCallback: true,
                    callbackInputKind: "code",
                  },
                  undefined,
                  complete,
                );
              }),
            ),
          );
        };
        const [exitCode] = yield* Effect.all(
          [child.exitCode, watch(child.stdout), watch(child.stderr)],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) {
          return yield* new ProviderSetupError({
            instanceId,
            operation: "start",
            detail: "Claude sign-in failed. Start again and choose the intended Claude account.",
          });
        }
        yield* context.verifying;
        const status = yield* readStatus;
        if (
          !status.loggedIn ||
          status.authMethod !== "claude.ai" ||
          status.apiProvider !== "firstParty"
        ) {
          return yield* new ProviderSetupError({
            instanceId,
            operation: "start",
            detail: "Claude could not verify a subscription account. Start sign-in again.",
          });
        }
      },
      Effect.mapError((cause) =>
        isSetupError(cause)
          ? cause
          : new ProviderSetupError({
              instanceId,
              operation: "start",
              detail: "Could not complete Claude sign-in. Try again.",
            }),
      ),
    ),
    logout: Effect.gen(function* () {
      if (!(yield* readStatus).loggedIn) return;
      const child = yield* spawn(["auth", "logout"]);
      const [exitCode] = yield* Effect.all(
        [child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0 || (yield* readStatus).loggedIn) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "logout",
          detail: "Claude is still signed in. Try signing out again.",
        });
      }
    }).pipe(
      Effect.scoped,
      Effect.timeout("20 seconds"),
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation: "logout",
            detail: "Could not sign out of Claude. Try again.",
          }),
      ),
    ),
  });
});
