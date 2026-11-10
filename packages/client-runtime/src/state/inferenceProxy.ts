import { type InferenceConsumer, type InferenceDriver, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { connectionRoutes } from "../connection/routes.ts";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { Atom } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { requestGuarded } from "../rpc/client.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentGuardedRpcQueryAtomFamily,
  createRuntimeCommand,
  withEnvironmentRpcPermissions,
} from "./runtime.ts";

export function createInferenceProxyAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const inferenceStatus = createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
    label: "inference:status",
    tag: WS_METHODS.inferenceStatus,
    execute: (input) => requestGuarded(WS_METHODS.inferenceStatus, input),
  });
  const updates = createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
    label: "inference:updates",
    tag: WS_METHODS.inferenceManage,
    execute: () => requestGuarded(WS_METHODS.inferenceManage, { operation: "checkUpdate" }),
  });
  const manageInference = createEnvironmentRpcCommand(runtime, {
    label: "inference:manage",
    tag: WS_METHODS.inferenceManage,
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() => {
        registry.refresh(inferenceStatus({ environmentId, input: {} }));
        if (input.operation === "configure" || input.operation === "update")
          registry.refresh(updates({ environmentId, input: { operation: "checkUpdate" } }));
      }),
  });
  const hostPermission = createCommandPermissions(runtime, WS_METHODS.inferenceGrant);
  const consumerPermission = createCommandPermissions(runtime, WS_METHODS.inferenceConnect);
  const routeInference = createRuntimeCommand(runtime, {
    label: "inference:route",
    execute: Effect.fn("InferenceProxy.route")(
      function* (
        input: { host: InferenceConsumer; consumer: InferenceConsumer; driver: InferenceDriver },
        registry: AtomRegistry.AtomRegistry,
      ) {
        yield* consumerPermission.authorize(registry, input.consumer.environmentId);
        const connections = yield* EnvironmentRegistry;
        const { grant, prepared } = yield* connections.run(
          input.host.environmentId,
          Effect.gen(function* () {
            const grant = yield* requestGuarded(WS_METHODS.inferenceGrant, {
              environmentId: input.consumer.environmentId,
              label: input.consumer.label,
            });
            const supervisor = yield* EnvironmentSupervisor;
            return { grant, prepared: yield* SubscriptionRef.get(supervisor.prepared) };
          }),
        );
        const entries = yield* SubscriptionRef.get(connections.entries);
        const entry = entries.get(input.host.environmentId);
        const active = Option.getOrUndefined(prepared);
        const target = active?.target;
        const profile =
          entry && target?._tag === "SshConnectionTarget"
            ? connectionRoutes(entry).find(
                (route) =>
                  route.target._tag === "SshConnectionTarget" &&
                  route.target.connectionId === target.connectionId,
              )?.profile
            : undefined;
        const ssh =
          profile && Option.isSome(profile) && profile.value._tag === "SshConnectionProfile"
            ? profile.value.target
            : undefined;
        // Without SSH, this client's loopback address for the host means nothing to the consumer.
        const reachable =
          ssh !== undefined ||
          !["127.0.0.1", "localhost", "[::1]"].includes(
            URL.parse(active?.httpBaseUrl ?? "")?.hostname ?? "",
          );
        const connection =
          active && reachable ? { url: active.httpBaseUrl, ...(ssh ? { ssh } : {}) } : undefined;
        registry.refresh(inferenceStatus({ environmentId: input.host.environmentId, input: {} }));
        yield* connections.run(
          input.consumer.environmentId,
          requestGuarded(WS_METHODS.inferenceConnect, {
            grant,
            driver: input.driver,
            hostLabel: input.host.label,
            ...(connection ? { connection } : {}),
          }),
        );
        registry.refresh(
          inferenceStatus({ environmentId: input.consumer.environmentId, input: {} }),
        );
      },
      (effect, _input, registry) =>
        effect.pipe(
          withEnvironmentRpcPermissions(runtime, registry),
          Effect.withTracerEnabled(false),
        ),
    ),
  });
  return {
    inferenceStatus,
    updates,
    manageInference,
    routeInference,
    canGrant: hostPermission.permissionAtom,
    canConnect: consumerPermission.permissionAtom,
  };
}
