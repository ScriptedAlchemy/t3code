import {
  SourceIdentityUnresolved,
  WS_METHODS,
  type CrossEnvironmentAsk,
  type CrossEnvironmentFulfillment,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { requestGuarded, subscribe } from "../rpc/client.ts";
import * as EnvironmentProjectCatalog from "./catalog.ts";
import { parseSourceProject, type ActiveProject } from "./match.ts";
import * as CrossEnvironmentPlacement from "./placement.ts";

const isSourceIdentityUnresolved = Schema.is(SourceIdentityUnresolved);

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
      if (isSourceIdentityUnresolved(source)) {
        return yield* source;
      }
      if (source === null) {
        return yield* new SourceIdentityUnresolved({ projectId: ask.sourceProjectId });
      }
      const caller = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const claim = Effect.fn("CrossEnvironmentBridgeClient.claim")(
        (environmentId: EnvironmentId) =>
          requestGuarded(WS_METHODS.crossEnvironmentBridgeClaim, {
            requestId: ask.requestId,
            environmentId,
          }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, caller),
            Effect.timeout("5 seconds"),
            Effect.catch((error) =>
              Effect.logWarning("Could not claim a cross-environment launch.", {
                ...safeErrorLogAttributes(error),
              }).pipe(Effect.as(false)),
            ),
          ),
      );
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
        claim,
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
        error,
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
    yield* subscribe(WS_METHODS.crossEnvironmentBridgeSubscribe, {}).pipe(
      Stream.mapEffect((ask) => answer(ask), { concurrency: 8, unordered: true }),
      Stream.runDrain,
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
