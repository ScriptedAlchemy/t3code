import { type InferenceConsumer, type InferenceDriver, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
        const connections = yield* EnvironmentRegistry;
        const grant = yield* connections.run(
          input.host.environmentId,
          requestGuarded(WS_METHODS.inferenceGrant, {
            environmentId: input.consumer.environmentId,
            label: input.consumer.label,
          }),
        );
        registry.refresh(inferenceStatus({ environmentId: input.host.environmentId, input: {} }));
        yield* connections.run(
          input.consumer.environmentId,
          requestGuarded(WS_METHODS.inferenceConnect, {
            grant,
            driver: input.driver,
            hostLabel: input.host.label,
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
