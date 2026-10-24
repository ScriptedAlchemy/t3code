import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectMissingOnTarget,
  ThreadId,
  WS_METHODS,
  type CrossEnvironmentAsk,
  type CrossEnvironmentFulfillment,
  type CrossEnvironmentLaunchAsk,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { runCrossEnvironmentBridgeClient } from "./bridgeClient.ts";
import * as EnvironmentProjectCatalog from "./catalog.ts";
import * as CrossEnvironmentPlacement from "./placement.ts";
import { makePlacementRegistry, projectShell } from "./placementTestSupport.ts";

const callerId = EnvironmentId.make("environment:caller");
const destId = EnvironmentId.make("environment:dest");
const sourceProjectId = ProjectId.make("project-source");
const destProjectId = ProjectId.make("project-dest");

const sourceShell = projectShell({
  id: sourceProjectId,
  canonicalKey: "github.com/org/repo",
  model: "source-model",
});
const matchedDest = projectShell({
  id: destProjectId,
  canonicalKey: "github.com/org/repo",
  model: "dest-model",
});
const unmatchedDest = projectShell({
  id: ProjectId.make("project-other"),
  canonicalKey: "github.com/org/other",
  model: "dest-model",
});

const launchAsk = {
  requestId: "ask-1",
  op: "launch",
  callerEnvironmentId: callerId,
  sourceProjectId,
  commandId: CommandId.make("command-1"),
  threadId: ThreadId.make("thread-1"),
  target: { kind: "environment", environmentId: destId },
  kind: "run",
  title: "Ship it",
  message: "do the thing",
  runtimeMode: "full-access",
  interactionMode: "default",
} satisfies CrossEnvironmentLaunchAsk;

const makeCallerSupervisor = Effect.fn("TestCrossEnvironmentBridge.makeCallerSupervisor")(
  function* (input: {
    readonly asks: Queue.Queue<CrossEnvironmentAsk>;
    readonly fulfillments: Queue.Queue<CrossEnvironmentFulfillment>;
  }) {
    const target = new PrimaryConnectionTarget({
      environmentId: callerId,
      label: "Caller",
      httpBaseUrl: "https://caller.example.test",
      wsBaseUrl: "wss://caller.example.test",
    });
    const client = {
      [WS_METHODS.crossEnvironmentBridgeSubscribe]: () => Stream.fromQueue(input.asks),
      [WS_METHODS.crossEnvironmentBridgeFulfill]: (body: CrossEnvironmentFulfillment) =>
        Queue.offer(input.fulfillments, body).pipe(Effect.asVoid),
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession = {
      client,
      initialConfig: Effect.succeed({
        environment: { capabilities: { repositoryIdentity: true } },
      } as never),
      subscribeServerConfig: () => Stream.empty,
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    return EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      }),
      session: yield* SubscriptionRef.make(Option.some(session)),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
  },
);

const fulfill = (destShells: readonly OrchestrationProjectShell[]) =>
  Effect.gen(function* () {
    const harness = yield* makePlacementRegistry([
      { id: callerId, label: "Caller" },
      { id: destId, label: "Dest" },
    ]);
    const asks = yield* Queue.unbounded<CrossEnvironmentAsk>();
    const fulfillments = yield* Queue.unbounded<CrossEnvironmentFulfillment>();
    const caller = yield* makeCallerSupervisor({ asks, fulfillments });
    const fulfillment = yield* Effect.gen(function* () {
      const catalog = yield* EnvironmentProjectCatalog.EnvironmentProjectCatalog;
      yield* catalog.replace(callerId, [sourceShell]);
      yield* catalog.replace(destId, destShells);
      yield* runCrossEnvironmentBridgeClient().pipe(Effect.forkScoped);
      yield* Queue.offer(asks, launchAsk);
      return yield* Queue.take(fulfillments);
    }).pipe(
      Effect.provide(
        CrossEnvironmentPlacement.layer.pipe(
          Layer.provideMerge(EnvironmentProjectCatalog.layer),
          Layer.provideMerge(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, harness.registry),
          ),
          Layer.provideMerge(Layer.succeed(EnvironmentSupervisor.EnvironmentSupervisor, caller)),
          Layer.provideMerge(Layer.succeed(RpcPermissionGuard, { authorize: () => Effect.void })),
        ),
      ),
    );
    return { fulfillment, launches: harness.launches };
  });

describe("cross-environment bridge client", () => {
  it.effect("fulfills a launch with the destination thread and root workspace", () =>
    Effect.gen(function* () {
      const { fulfillment, launches } = yield* fulfill([matchedDest]);
      expect(fulfillment).toMatchObject({
        requestId: "ask-1",
        op: "launch",
        result: {
          environmentId: destId,
          projectId: destProjectId,
          threadId: ThreadId.make("thread-1"),
          kind: "run",
        },
      });
      expect(launches).toHaveLength(1);
      expect(launches[0]?.input).toMatchObject({
        projectId: destProjectId,
        workspaceStrategy: { type: "root" },
        creationSource: "mcp",
      });
    }),
  );

  it.effect("fulfills ProjectMissingOnTarget without calling launchThread", () =>
    Effect.gen(function* () {
      const { fulfillment, launches } = yield* fulfill([unmatchedDest]);
      if (!("error" in fulfillment)) {
        throw new Error("expected a refusal");
      }
      expect(fulfillment.error).toBeInstanceOf(ProjectMissingOnTarget);
      expect(fulfillment.error).toMatchObject({
        environmentId: destId,
        _tag: "ProjectMissingOnTarget",
      });
      expect(launches).toEqual([]);
    }),
  );
});
