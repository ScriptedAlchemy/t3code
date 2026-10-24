import {
  CrossEnvironmentLaunchRejected,
  SourceIdentityUnresolved,
  WS_METHODS,
  isCrossEnvironmentFailure,
  type CrossEnvironmentAsk,
  type CrossEnvironmentFulfillment,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { requestGuarded, subscribe } from "../rpc/client.ts";
import * as EnvironmentProjectCatalog from "./catalog.ts";
import { parseSourceProject, type ActiveProject } from "./match.ts";
import * as CrossEnvironmentPlacement from "./placement.ts";

const lookupSource = (
  shells: readonly OrchestrationProjectShell[],
  projectId: ProjectId | undefined,
): ActiveProject | SourceIdentityUnresolved | null => {
  if (projectId === undefined) return null;
  const shell = shells.find((candidate) => candidate.id === projectId);
  if (shell === undefined) return new SourceIdentityUnresolved({ projectId });
  return parseSourceProject({ id: shell.id, repositoryIdentity: shell.repositoryIdentity ?? null });
};

const respond = Effect.fn("CrossEnvironmentBridgeClient.respond")(function* (
  ask: CrossEnvironmentAsk,
  source: ActiveProject | SourceIdentityUnresolved | null,
) {
  const placement = yield* CrossEnvironmentPlacement.CrossEnvironmentPlacement;
  switch (ask.op) {
    case "list": {
      const result = yield* placement.list({
        callerEnvironmentId: ask.callerEnvironmentId,
        source,
      });
      return { requestId: ask.requestId, op: "list" as const, result };
    }
    case "launch": {
      if (Schema.is(SourceIdentityUnresolved)(source)) {
        return yield* source;
      }
      if (source === null) {
        return yield* new SourceIdentityUnresolved({ projectId: ask.sourceProjectId });
      }
      const result = yield* placement.launch({
        callerEnvironmentId: ask.callerEnvironmentId,
        source,
        commandId: ask.commandId,
        threadId: ask.threadId,
        target: ask.target,
        kind: ask.kind,
        title: ask.title,
        ...(ask.message === undefined ? {} : { message: ask.message }),
        runtimeMode: ask.runtimeMode,
        interactionMode: ask.interactionMode,
      });
      return { requestId: ask.requestId, op: "launch" as const, result };
    }
    default: {
      const unexpected: never = ask;
      return unexpected;
    }
  }
});

const answer = Effect.fn("CrossEnvironmentBridgeClient.answer")(function* (
  ask: CrossEnvironmentAsk,
) {
  const catalog = yield* EnvironmentProjectCatalog.EnvironmentProjectCatalog;
  const source = lookupSource(
    yield* catalog.projects(ask.callerEnvironmentId),
    ask.sourceProjectId,
  );
  const fulfillment = yield* respond(ask, source).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        requestId: ask.requestId,
        error: isCrossEnvironmentFailure(error) ? error : new CrossEnvironmentLaunchRejected(),
      } satisfies CrossEnvironmentFulfillment),
    ),
  );
  yield* requestGuarded(WS_METHODS.crossEnvironmentBridgeFulfill, fulfillment).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not fulfill a cross-environment ask.", {
        ...safeErrorLogAttributes(error),
      }),
    ),
  );
});

export const runCrossEnvironmentBridgeClient = Effect.fn("CrossEnvironmentBridgeClient.run")(
  function* () {
    // Server-config tests build this state with a partial RPC client. Subscribe
    // only when the connection runtime is actually present.
    const registry = yield* Effect.serviceOption(EnvironmentRegistry.EnvironmentRegistry);
    const catalog = yield* Effect.serviceOption(
      EnvironmentProjectCatalog.EnvironmentProjectCatalog,
    );
    const placement = yield* Effect.serviceOption(
      CrossEnvironmentPlacement.CrossEnvironmentPlacement,
    );
    if (Option.isNone(registry) || Option.isNone(catalog) || Option.isNone(placement)) {
      return;
    }
    // The subscription's requirements stay on this branch. Tests that build
    // server-config state without the connection runtime must not inherit them.
    yield* subscribe(WS_METHODS.crossEnvironmentBridgeSubscribe, {}).pipe(
      Stream.runForEach((ask) => answer(ask)),
      Effect.catchCause((cause) =>
        Effect.logWarning("The cross-environment bridge subscription ended.", { cause }),
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry.value),
          Layer.succeed(EnvironmentProjectCatalog.EnvironmentProjectCatalog, catalog.value),
          Layer.succeed(CrossEnvironmentPlacement.CrossEnvironmentPlacement, placement.value),
        ),
      ),
    );
  },
);
