import {
  CommandId,
  EnvironmentId,
  PeerCatalogUnavailable,
  ProjectId,
  ThreadId,
  type ConnectedEnvironmentsResult,
  type CrossEnvironmentLaunchResult,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import * as CrossEnvironmentBridge from "./CrossEnvironmentBridge.ts";

const callerId = EnvironmentId.make("environment:caller");
const peerId = EnvironmentId.make("environment:peer");
const projectId = ProjectId.make("project-peer");

const resources = {
  sampledAt: 5,
  cpuUtilization: 0.2,
  cpuCount: 4,
  availableMemoryBytes: 1_000,
  totalMemoryBytes: 2_000,
};

const listed: ConnectedEnvironmentsResult = {
  callerEnvironmentId: callerId,
  environments: [
    {
      environmentId: peerId,
      label: "Peer",
      isCaller: false,
      resources,
      receivedAt: 5,
      repository: { tag: "matched", projectId },
    },
  ],
};

const launchInput = {
  callerEnvironmentId: callerId,
  sourceProjectId: ProjectId.make("project-source"),
  commandId: CommandId.make("command:1"),
  threadId: ThreadId.make("thread:1"),
  target: { kind: "environment" as const, environmentId: peerId },
  kind: "run" as const,
  title: "Ship it",
  message: "do the thing",
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
};

const launched: CrossEnvironmentLaunchResult = {
  environmentId: peerId,
  projectId,
  threadId: ThreadId.make("thread:1"),
  runId: null,
  status: null,
  kind: "thread",
};

const provideBridge = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(CrossEnvironmentBridge.layer.pipe(Layer.provide(NodeCrypto.layer))));

it.effect("returns the first list fulfillment and ignores a second one", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const stream = yield* bridge.listen();
    const empty: ConnectedEnvironmentsResult = {
      callerEnvironmentId: callerId,
      environments: [],
    };
    yield* Stream.runForEach(stream, (ask) =>
      ask.op === "list"
        ? bridge
            .fulfill({ requestId: ask.requestId, op: "list", result: listed })
            .pipe(
              Effect.andThen(
                bridge.fulfill({ requestId: ask.requestId, op: "list", result: empty }),
              ),
            )
        : Effect.void,
    ).pipe(Effect.forkScoped);
    expect(yield* bridge.askList({ callerEnvironmentId: callerId })).toEqual(listed);
  }).pipe(provideBridge),
);

it.effect("returns PeerCatalogUnavailable when a launch has no subscriber", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const error = yield* bridge.askLaunch(launchInput).pipe(Effect.flip);
    expect(error).toBeInstanceOf(PeerCatalogUnavailable);
    expect(error._tag).toBe("PeerCatalogUnavailable");
  }).pipe(provideBridge),
);

it.effect("replays a pending ask to the subscriber that replaces the previous one", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const first = yield* bridge.listen();
    const asked = yield* bridge.askList({ callerEnvironmentId: callerId }).pipe(Effect.forkScoped);
    const firstAsk = yield* Stream.runHead(Stream.take(first, 1));
    const second = yield* bridge.listen();
    const replayed = yield* Stream.runHead(Stream.take(second, 1));
    expect(Option.getOrThrow(replayed).requestId).toBe(Option.getOrThrow(firstAsk).requestId);
    yield* bridge.fulfill({
      requestId: Option.getOrThrow(replayed).requestId,
      op: "list",
      result: listed,
    });
    expect(yield* Fiber.join(asked)).toEqual(listed);
  }).pipe(provideBridge),
);

it.effect("fails a pending ask when the last subscriber disconnects", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const scope = yield* Scope.make();
    const seen = yield* Deferred.make<void>();
    const stream = yield* bridge.listen().pipe(Scope.provide(scope));
    yield* Stream.runForEach(stream, () => Deferred.succeed(seen, undefined)).pipe(
      Effect.forkScoped,
    );
    const asked = yield* bridge.askLaunch(launchInput).pipe(Effect.as(launched), Effect.forkScoped);
    yield* Deferred.await(seen);
    yield* Scope.close(scope, Exit.void);
    const error = yield* Fiber.join(asked).pipe(Effect.flip);
    expect(error).toBeInstanceOf(PeerCatalogUnavailable);
  }).pipe(provideBridge),
);
