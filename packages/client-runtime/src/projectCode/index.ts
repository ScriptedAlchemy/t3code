import { WS_METHODS, type ProjectCodeQueryInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  EnvironmentRpcUnavailableError,
  getInitialServerConfig,
  requestGuarded,
} from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily } from "../state/runtime.ts";

export function createProjectCodeAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    query: createEnvironmentQueryAtomFamily(runtime, {
      label: "project-code:query",
      staleTimeMs: 0,
      execute: (input: ProjectCodeQueryInput) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
          const config = yield* getInitialServerConfig();
          if (config.environment.capabilities.projectCode !== true) {
            return yield* new EnvironmentRpcUnavailableError({
              environmentId: supervisor.target.environmentId,
              message: "This server does not support project code queries.",
            });
          }
          return yield* requestGuarded(WS_METHODS.projectCodeQuery, input);
        }),
    }),
  };
}
