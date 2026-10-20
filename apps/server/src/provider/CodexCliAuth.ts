import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import type * as CodexSchema from "effect-codex-app-server/schema";

import type { CodexEffectiveRuntime } from "./CodexManagedRuntime.ts";
import { withCodexAppServerClient } from "./CodexProvider.ts";

const isProviderSetupError = Schema.is(ProviderSetupError);

export const makeCodexCliAuth = Effect.fn("makeCodexCliAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly homePath: string;
  readonly resolveRuntime: Effect.Effect<CodexEffectiveRuntime, never, Scope.Scope>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const open = options.resolveRuntime.pipe(
    Effect.flatMap((runtime) =>
      withCodexAppServerClient({
        binaryPath: runtime.config.binaryPath,
        homePath: runtime.config.homePath,
        launchArgs: runtime.config.launchArgs,
        environment: runtime.environment,
        extendEnv: false,
        cwd: options.homePath,
      }),
    ),
  );
  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: options.homePath },
    defaultMethodId: "deviceCode",
    methods: Effect.succeed([
      {
        id: "deviceCode",
        name: "Device code",
        description: "Sign in from any browser, including on another device.",
        type: "agent",
      },
      {
        id: "browser",
        name: "Browser on server machine",
        description: "Use a browser on the machine running this environment.",
        type: "agent",
      },
    ]),
    authenticate: Effect.fn("CodexCliAuth.authenticate")(
      function* (methodId, context) {
        const { client, exitCode } = yield* open;
        const completions =
          yield* Queue.unbounded<CodexSchema.V2AccountLoginCompletedNotification>();
        yield* client.handleServerNotification("account/login/completed", (notification) =>
          Queue.offer(completions, notification).pipe(Effect.asVoid),
        );
        const login = yield* client.request("account/login/start", {
          type: methodId === "browser" ? "chatgpt" : "chatgptDeviceCode",
        });
        if (login.type !== "chatgpt" && login.type !== "chatgptDeviceCode") {
          return yield* new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "start",
            detail: "Codex did not start the requested sign-in method. Try again.",
          });
        }
        let verified = false;
        yield* Effect.addFinalizer(() =>
          verified
            ? Effect.void
            : client
                .request("account/login/cancel", { loginId: login.loginId })
                .pipe(Effect.timeout("2 seconds"), Effect.ignore),
        );
        yield* context.setInteraction(
          login.type === "chatgpt"
            ? {
                type: "browser",
                id: context.flowId,
                url: login.authUrl,
                requiresConsent: false,
              }
            : {
                type: "deviceCode",
                id: context.flowId,
                url: login.verificationUrl,
                userCode: login.userCode,
              },
        );
        const completion = yield* Effect.raceFirst(
          Effect.gen(function* () {
            let notification = yield* Queue.take(completions);
            while (notification.loginId != null && notification.loginId !== login.loginId) {
              notification = yield* Queue.take(completions);
            }
            return notification;
          }),
          exitCode.pipe(
            Effect.flatMap(
              () =>
                new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "start",
                  detail: "Codex closed before sign-in completed. Try again.",
                }),
            ),
          ),
        );
        if (!completion.success) {
          return yield* new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "start",
            detail: "Codex sign-in failed. Start again and choose the intended OpenAI account.",
          });
        }
        yield* context.verifying;
        const account = yield* client.request("account/read", {});
        if (account.account?.type !== "chatgpt") {
          return yield* new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "start",
            detail: "Codex could not verify the signed-in account. Try again.",
          });
        }
        verified = true;
      },
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError((cause) =>
        isProviderSetupError(cause)
          ? cause
          : new ProviderSetupError({
              instanceId: options.instanceId,
              operation: "start",
              detail: "Could not complete Codex sign-in. Try again.",
            }),
      ),
    ),
    logout: Effect.gen(function* () {
      const { client } = yield* open;
      yield* client.request("account/logout", undefined);
      const account = yield* client.request("account/read", {});
      if (account.account) {
        return yield* new ProviderSetupError({
          instanceId: options.instanceId,
          operation: "logout",
          detail: "Codex is still signed in. Try signing out again.",
        });
      }
    }).pipe(
      Effect.scoped,
      Effect.timeout("20 seconds"),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "logout",
            detail: "Could not sign out of Codex. Try again.",
          }),
      ),
    ),
  });
});
