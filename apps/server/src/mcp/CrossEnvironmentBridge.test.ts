import {
  CommandId,
  CrossEnvironmentLaunchUncertain,
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
import * as TestClock from "effect/testing/TestClock";
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
    const stream = yield* bridge.listen("client-1");
    const empty: ConnectedEnvironmentsResult = {
      callerEnvironmentId: callerId,
      environments: [],
    };
    yield* Stream.runForEach(stream, (ask) =>
      ask.op === "list"
        ? bridge
            .fulfill("client-1", { requestId: ask.requestId, op: "list", result: listed })
            .pipe(
              Effect.andThen(
                bridge.fulfill("client-1", { requestId: ask.requestId, op: "list", result: empty }),
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

it.effect("fails a pending catalog request when another client takes over", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const first = yield* bridge.listen("client-1");
    const asked = yield* bridge.askList({ callerEnvironmentId: callerId }).pipe(Effect.forkScoped);
    yield* Stream.runHead(Stream.take(first, 1));
    yield* bridge.listen("client-2").pipe(Effect.asVoid);
    expect(yield* Fiber.join(asked).pipe(Effect.flip)).toBeInstanceOf(PeerCatalogUnavailable);
  }).pipe(provideBridge),
);

it.effect("reports an unconfirmed launch when the last subscriber disconnects", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const scope = yield* Scope.make();
    const seen = yield* Deferred.make<void>();
    const stream = yield* bridge.listen("client-1").pipe(Scope.provide(scope));
    yield* Stream.runForEach(stream, () => Deferred.succeed(seen, undefined)).pipe(
      Effect.forkScoped,
    );
    const asked = yield* bridge.askLaunch(launchInput).pipe(Effect.as(launched), Effect.forkScoped);
    yield* Deferred.await(seen);
    yield* Scope.close(scope, Exit.void);
    const error = yield* Fiber.join(asked).pipe(Effect.flip);
    expect(error).toBeInstanceOf(CrossEnvironmentLaunchUncertain);
    expect(error).toMatchObject({ threadId: launchInput.threadId, environmentId: peerId });
  }).pipe(provideBridge),
);

it.effect("accepts fulfillment only from the connection that received the ask", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    yield* bridge.listen("client-1").pipe(Effect.asVoid);
    const stream = yield* bridge.listen("client-2");
    const asked = yield* bridge.askList({ callerEnvironmentId: callerId }).pipe(Effect.forkScoped);
    const ask = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    yield* bridge.fulfill("client-1", {
      requestId: ask.requestId,
      op: "list",
      result: { callerEnvironmentId: callerId, environments: [] },
    });
    yield* bridge.fulfill("client-2", { requestId: ask.requestId, op: "list", result: listed });
    expect(yield* Fiber.join(asked)).toEqual(listed);
  }).pipe(provideBridge),
);

it.effect("times out a catalog request when a subscribed client stops responding", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const stream = yield* bridge.listen("client-1");
    const asked = yield* bridge.askList({ callerEnvironmentId: callerId }).pipe(Effect.forkScoped);
    yield* Stream.runHead(Stream.take(stream, 1));
    yield* TestClock.adjust("15 seconds");
    expect(yield* Fiber.join(asked).pipe(Effect.flip)).toBeInstanceOf(PeerCatalogUnavailable);
  }).pipe(provideBridge),
);

it.effect("reports a timed-out launch as uncertain and ignores its late acknowledgement", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const stream = yield* bridge.listen("client-1");
    const asked = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    const ask = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    yield* TestClock.adjust("1 minute");
    const result = yield* Fiber.join(asked).pipe(Effect.flip);
    expect(result).toMatchObject({
      _tag: "CrossEnvironmentLaunchUncertain",
      threadId: launchInput.threadId,
      environmentId: peerId,
    });
    yield* bridge.fulfill("client-1", { requestId: ask.requestId, op: "launch", result: launched });
    expect(yield* Fiber.join(asked).pipe(Effect.flip)).toEqual(result);
  }).pipe(provideBridge),
);

it.effect("closing a replaced subscriber does not disconnect its replacement", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const firstScope = yield* Scope.make();
    yield* bridge.listen("client-1").pipe(Scope.provide(firstScope), Effect.asVoid);
    const stream = yield* bridge.listen("client-2");
    yield* Scope.close(firstScope, Exit.void);
    expect(yield* bridge.hasSubscriber).toBe(true);
    const asked = yield* bridge.askList({ callerEnvironmentId: callerId }).pipe(Effect.forkScoped);
    const ask = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    yield* bridge.fulfill("client-2", { requestId: ask.requestId, op: "list", result: listed });
    expect(yield* Fiber.join(asked)).toEqual(listed);
  }).pipe(provideBridge),
);

it.effect("promotes the previous connected client when the newest client disconnects", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const first = yield* bridge.listen("client-1");
    const secondScope = yield* Scope.make();
    yield* bridge.listen("client-2").pipe(Scope.provide(secondScope), Effect.asVoid);
    yield* Scope.close(secondScope, Exit.void);
    expect(yield* bridge.hasSubscriber).toBe(true);
    const asked = yield* bridge.askList({ callerEnvironmentId: callerId }).pipe(Effect.forkScoped);
    const ask = Option.getOrThrow(yield* Stream.runHead(Stream.take(first, 1)));
    yield* bridge.fulfill("client-1", { requestId: ask.requestId, op: "list", result: listed });
    expect(yield* Fiber.join(asked)).toEqual(listed);
  }).pipe(provideBridge),
);

it.effect("keeps a newer subscription when an older subscription on the same socket closes", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const oldScope = yield* Scope.make();
    yield* bridge.listen("client-1").pipe(Scope.provide(oldScope), Effect.asVoid);
    const stream = yield* bridge.listen("client-1");
    yield* Scope.close(oldScope, Exit.void);
    const asked = yield* bridge.askList({ callerEnvironmentId: callerId }).pipe(Effect.forkScoped);
    const ask = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    yield* bridge.fulfill("client-1", { requestId: ask.requestId, op: "list", result: listed });
    expect(yield* Fiber.join(asked)).toEqual(listed);
  }).pipe(provideBridge),
);

it.effect("allows one claim by the receiving connection for the requested destination", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const stream = yield* bridge.listen("client-1");
    const asked = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    const ask = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    const claim = { requestId: ask.requestId, environmentId: peerId };
    expect(yield* bridge.claim("other-client", claim)).toBe(false);
    expect(yield* bridge.claim("client-1", { ...claim, environmentId: callerId })).toBe(false);
    expect(
      yield* bridge.claim("client-1", {
        ...claim,
        environmentId: EnvironmentId.make("wrong-peer"),
      }),
    ).toBe(false);
    expect(yield* bridge.claim("client-1", claim)).toBe(true);
    expect(yield* bridge.claim("client-1", claim)).toBe(false);
    yield* bridge.fulfill("client-1", { requestId: ask.requestId, op: "launch", result: launched });
    expect(yield* Fiber.join(asked)).toEqual(launched);
  }).pipe(provideBridge),
);

it.effect("refuses claims for canceled, expired, and superseded requests", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const stream = yield* bridge.listen("client-1");
    const canceled = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    const canceledAsk = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    yield* Fiber.interrupt(canceled);
    expect(
      yield* bridge.claim("client-1", { requestId: canceledAsk.requestId, environmentId: peerId }),
    ).toBe(false);

    const expired = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    const expiredAsk = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    yield* TestClock.adjust("1 minute");
    expect(yield* Fiber.join(expired).pipe(Effect.flip)).toBeInstanceOf(
      CrossEnvironmentLaunchUncertain,
    );
    expect(
      yield* bridge.claim("client-1", { requestId: expiredAsk.requestId, environmentId: peerId }),
    ).toBe(false);

    const superseded = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    const supersededAsk = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    yield* bridge.listen("client-2").pipe(Effect.asVoid);
    expect(yield* Fiber.join(superseded).pipe(Effect.flip)).toBeInstanceOf(
      CrossEnvironmentLaunchUncertain,
    );
    expect(
      yield* bridge.claim("client-1", {
        requestId: supersededAsk.requestId,
        environmentId: peerId,
      }),
    ).toBe(false);
    expect(
      yield* bridge.claim("client-2", {
        requestId: supersededAsk.requestId,
        environmentId: peerId,
      }),
    ).toBe(false);
  }).pipe(provideBridge),
);

it.effect("reports the chosen load-balanced destination after a claimed launch times out", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const stream = yield* bridge.listen("client-1");
    const asked = yield* bridge
      .askLaunch({ ...launchInput, target: { kind: "load_balanced" } })
      .pipe(Effect.forkScoped);
    const ask = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    expect(
      yield* bridge.claim("client-1", { requestId: ask.requestId, environmentId: peerId }),
    ).toBe(true);
    yield* TestClock.adjust("1 minute");
    expect(yield* Fiber.join(asked).pipe(Effect.flip)).toMatchObject({
      _tag: "CrossEnvironmentLaunchUncertain",
      threadId: launchInput.threadId,
      environmentId: peerId,
    });
  }).pipe(provideBridge),
);

it.effect("does not replay a canceled ask to a replacement subscriber", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const first = yield* bridge.listen("client-1");
    const canceled = yield* bridge
      .askList({ callerEnvironmentId: callerId })
      .pipe(Effect.forkScoped);
    const canceledAsk = Option.getOrThrow(yield* Stream.runHead(Stream.take(first, 1)));
    yield* Fiber.interrupt(canceled);

    const second = yield* bridge.listen("client-1");
    const fresh = yield* bridge.askList({ callerEnvironmentId: callerId }).pipe(Effect.forkScoped);
    const nextAsk = Option.getOrThrow(yield* Stream.runHead(Stream.take(second, 1)));
    expect(nextAsk.requestId).not.toBe(canceledAsk.requestId);
    yield* bridge.fulfill("client-1", { requestId: nextAsk.requestId, op: "list", result: listed });
    expect(yield* Fiber.join(fresh)).toEqual(listed);
  }).pipe(provideBridge),
);

it.effect("does not replay a launch that the previous subscriber may have dispatched", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const first = yield* bridge.listen("client-1");
    const launch = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    const firstAsk = Option.getOrThrow(yield* Stream.runHead(Stream.take(first, 1)));
    expect(firstAsk.op).toBe("launch");

    const second = yield* bridge.listen("client-1");
    const fresh = yield* bridge.askList({ callerEnvironmentId: callerId }).pipe(Effect.forkScoped);
    const nextAsk = Option.getOrThrow(yield* Stream.runHead(Stream.take(second, 1)));
    expect(nextAsk.op).toBe("list");
    expect(nextAsk.requestId).not.toBe(firstAsk.requestId);
    yield* bridge.fulfill("client-1", { requestId: nextAsk.requestId, op: "list", result: listed });
    expect(yield* Fiber.join(fresh)).toEqual(listed);
    expect(yield* Fiber.join(launch).pipe(Effect.flip)).toMatchObject({
      _tag: "CrossEnvironmentLaunchUncertain",
      threadId: launchInput.threadId,
    });
  }).pipe(provideBridge),
);

it.effect("shares one in-flight launch between retries with the same command id", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const stream = yield* bridge.listen("client-1");
    const seen = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let dispatched = 0;
    const result = { ...launched, kind: launchInput.kind };
    yield* Stream.runForEach(stream, (ask) =>
      Effect.gen(function* () {
        dispatched++;
        yield* Deferred.succeed(seen, undefined);
        yield* Deferred.await(release);
        yield* bridge.fulfill("client-1", { requestId: ask.requestId, op: "launch", result });
      }),
    ).pipe(Effect.forkScoped);
    const first = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    yield* Deferred.await(seen);
    const retry = yield* bridge
      .askLaunch(launchInput)
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(first)).toEqual(result);
    expect(yield* Fiber.join(retry)).toEqual(result);
    expect(dispatched).toBe(1);
  }).pipe(provideBridge),
);

it.effect("canceling a duplicate waiter leaves the original launch active", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const stream = yield* bridge.listen("client-1");
    const first = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    const ask = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    const retry = yield* bridge
      .askLaunch(launchInput)
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Fiber.interrupt(retry);
    const result = { ...launched, kind: launchInput.kind };
    yield* bridge.fulfill("client-1", { requestId: ask.requestId, op: "launch", result });
    expect(yield* Fiber.join(first)).toEqual(result);
  }).pipe(provideBridge),
);

it.effect("canceling the original launch notifies every duplicate waiter", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const stream = yield* bridge.listen("client-1");
    const first = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    yield* Stream.runHead(Stream.take(stream, 1));
    const retry = yield* bridge
      .askLaunch(launchInput)
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Fiber.interrupt(first);
    expect(yield* Fiber.join(retry).pipe(Effect.flip)).toMatchObject({
      _tag: "CrossEnvironmentLaunchUncertain",
      threadId: launchInput.threadId,
      environmentId: peerId,
    });
  }).pipe(provideBridge),
);
