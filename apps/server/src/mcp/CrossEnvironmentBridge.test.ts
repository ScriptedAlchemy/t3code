import {
  CommandId,
  CrossEnvironmentLaunchUncertain,
  EnvironmentId,
  PeerCatalogUnavailable,
  ProjectId,
  ProviderInstanceId,
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
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import * as CrossEnvironmentBridge from "./CrossEnvironmentBridge.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

const callerId = EnvironmentId.make("environment:caller");
const peerId = EnvironmentId.make("environment:peer");
const projectId = ProjectId.make("project-peer");
const destination = {
  environmentId: peerId,
  projectId,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "peer-model" },
};

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
  kind: "run",
};

const provideBridge = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      CrossEnvironmentBridge.layer.pipe(
        Layer.provideMerge([NodeCrypto.layer, SqlitePersistence.layerMemory]),
      ),
    ),
  );

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
    const claim = { ...destination, requestId: ask.requestId, environmentId: peerId };
    expect(yield* bridge.claim("other-client", claim)).toBe(false);
    expect(
      yield* bridge.claim("client-1", { ...destination, ...claim, environmentId: callerId }),
    ).toBe(false);
    expect(
      yield* bridge.claim("client-1", {
        ...destination,
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
      yield* bridge.claim("client-1", {
        ...destination,
        requestId: canceledAsk.requestId,
        environmentId: peerId,
      }),
    ).toBe(false);

    const expired = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    const expiredAsk = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    yield* TestClock.adjust("1 minute");
    expect(yield* Fiber.join(expired).pipe(Effect.flip)).toBeInstanceOf(
      CrossEnvironmentLaunchUncertain,
    );
    expect(
      yield* bridge.claim("client-1", {
        ...destination,
        requestId: expiredAsk.requestId,
        environmentId: peerId,
      }),
    ).toBe(false);

    const superseded = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    const supersededAsk = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    yield* bridge.listen("client-2").pipe(Effect.asVoid);
    expect(yield* Fiber.join(superseded).pipe(Effect.flip)).toBeInstanceOf(
      CrossEnvironmentLaunchUncertain,
    );
    expect(
      yield* bridge.claim("client-1", {
        ...destination,
        requestId: supersededAsk.requestId,
        environmentId: peerId,
      }),
    ).toBe(false);
    expect(
      yield* bridge.claim("client-2", {
        ...destination,
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
      yield* bridge.claim("client-1", {
        ...destination,
        requestId: ask.requestId,
        environmentId: peerId,
      }),
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
        yield* bridge.claim("client-1", { ...destination, requestId: ask.requestId });
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
    yield* bridge.claim("client-1", { ...destination, requestId: ask.requestId });
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

it.effect("replays a confirmed launch after the client disconnects", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const clientScope = yield* Scope.make();
    const stream = yield* bridge
      .listen("client-1")
      .pipe(Effect.provideService(Scope.Scope, clientScope));
    const result = { ...launched, kind: launchInput.kind };
    yield* Stream.runForEach(stream, (ask) =>
      bridge
        .claim("client-1", { ...destination, requestId: ask.requestId, environmentId: peerId })
        .pipe(
          Effect.andThen(
            bridge.fulfill("client-1", { requestId: ask.requestId, op: "launch", result }),
          ),
        ),
    ).pipe(Effect.forkScoped);
    expect(yield* bridge.askLaunch(launchInput)).toEqual(result);
    yield* Scope.close(clientScope, Exit.void);
    expect(yield* bridge.askLaunch(launchInput)).toEqual(result);
  }).pipe(provideBridge),
);

it.effect("keeps a lost-acknowledgement retry on the claimed load-balanced destination", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const clientScope = yield* Scope.make();
    const stream = yield* bridge
      .listen("client-1")
      .pipe(Effect.provideService(Scope.Scope, clientScope));
    const input = { ...launchInput, target: { kind: "load_balanced" as const } };
    const first = yield* bridge.askLaunch(input).pipe(Effect.forkScoped);
    const ask = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    expect(
      yield* bridge.claim("client-1", {
        ...destination,
        requestId: ask.requestId,
        environmentId: peerId,
      }),
    ).toBe(true);
    yield* Scope.close(clientScope, Exit.void);
    expect(yield* Fiber.join(first).pipe(Effect.flip)).toMatchObject({ environmentId: peerId });
    const replacement = yield* bridge.listen("client-2");
    yield* bridge.askLaunch(input).pipe(Effect.forkScoped);
    const retry = Option.getOrThrow(yield* Stream.runHead(Stream.take(replacement, 1)));
    expect(retry).toMatchObject({
      target: { kind: "environment", environmentId: peerId },
      commandId: input.commandId,
      threadId: input.threadId,
    });
  }).pipe(provideBridge),
);

it.effect("rejects changed parameters instead of coalescing them with an active command", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const stream = yield* bridge.listen("client-1");
    const first = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    const ask = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    const changed = yield* bridge
      .askLaunch({ ...launchInput, message: "different work" })
      .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }));
    yield* bridge.claim("client-1", {
      ...destination,
      requestId: ask.requestId,
      environmentId: peerId,
    });
    yield* bridge.fulfill("client-1", {
      requestId: ask.requestId,
      op: "launch",
      result: { ...launched, kind: launchInput.kind },
    });
    yield* Fiber.join(first);
    const outcome = yield* Fiber.join(changed);
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(String(outcome)).toContain("CrossEnvironmentRequestConflict");
  }).pipe(provideBridge),
);

it.effect("atomically pins competing clients to one destination across bridge instances", () =>
  Effect.gen(function* () {
    const first = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const second = yield* CrossEnvironmentBridge.CrossEnvironmentBridge.pipe(
      Effect.provide(Layer.fresh(CrossEnvironmentBridge.layer)),
    );
    const firstStream = yield* first.listen("first-client");
    const secondStream = yield* second.listen("second-client");
    const input = { ...launchInput, target: { kind: "load_balanced" as const } };
    yield* first.askLaunch(input).pipe(Effect.forkScoped);
    yield* second.askLaunch(input).pipe(Effect.forkScoped);
    const firstAsk = Option.getOrThrow(yield* Stream.runHead(Stream.take(firstStream, 1)));
    const secondAsk = Option.getOrThrow(yield* Stream.runHead(Stream.take(secondStream, 1)));
    const otherDestination = { ...destination, environmentId: EnvironmentId.make("another-peer") };
    const claims = yield* Effect.all(
      [
        first.claim("first-client", { ...destination, requestId: firstAsk.requestId }),
        second.claim("second-client", { ...otherDestination, requestId: secondAsk.requestId }),
      ],
      { concurrency: "unbounded" },
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly environmentId: string }>`
      SELECT json_extract(destination_json, '$.environmentId') AS environmentId
      FROM cross_environment_launches WHERE command_id = ${input.commandId}
    `;
    expect(rows[0]?.environmentId).toBe(claims[0] ? peerId : otherDestination.environmentId);
  }).pipe(provideBridge),
);

it.effect("refuses dispatch when the destination cannot be saved", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const sql = yield* SqlClient.SqlClient;
    const stream = yield* bridge.listen("client-1");
    yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    const ask = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    yield* sql`CREATE TRIGGER reject_route BEFORE UPDATE OF destination_json ON cross_environment_launches
      BEGIN SELECT RAISE(FAIL, 'simulated write failure'); END`;
    expect(yield* bridge.claim("client-1", { ...destination, requestId: ask.requestId })).toBe(
      false,
    );
    const rows = yield* sql`SELECT destination_json FROM cross_environment_launches`;
    expect(rows).toEqual([{ destination_json: null }]);
    yield* sql`DROP TRIGGER reject_route`;
    expect(yield* bridge.claim("client-1", { ...destination, requestId: ask.requestId })).toBe(
      true,
    );
  }).pipe(provideBridge),
);

it.effect("retains the chosen destination when persisting a confirmation fails", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const sql = yield* SqlClient.SqlClient;
    const stream = yield* bridge.listen("client-1");
    const input = { ...launchInput, target: { kind: "load_balanced" as const } };
    const first = yield* bridge.askLaunch(input).pipe(Effect.forkScoped);
    const ask = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    expect(yield* bridge.claim("client-1", { ...destination, requestId: ask.requestId })).toBe(
      true,
    );
    yield* sql`CREATE TRIGGER reject_result BEFORE UPDATE OF result_json ON cross_environment_launches
      BEGIN SELECT RAISE(FAIL, 'simulated write failure'); END`;
    yield* bridge.fulfill("client-1", { requestId: ask.requestId, op: "launch", result: launched });
    expect(yield* Fiber.join(first).pipe(Effect.flip)).toMatchObject({
      _tag: "CrossEnvironmentLaunchUncertain",
      environmentId: peerId,
      threadId: launchInput.threadId,
    });
    yield* sql`DROP TRIGGER reject_result`;
    const retry = yield* bridge.askLaunch(input).pipe(Effect.forkScoped);
    const retriedAsk = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    expect(retriedAsk).toMatchObject({
      destination,
      target: { kind: "environment", environmentId: peerId },
    });
    expect(
      yield* bridge.claim("client-1", { ...destination, requestId: retriedAsk.requestId }),
    ).toBe(true);
    yield* bridge.fulfill("client-1", {
      requestId: retriedAsk.requestId,
      op: "launch",
      result: launched,
    });
    expect(yield* Fiber.join(retry)).toEqual(launched);
  }).pipe(provideBridge),
);

it.effect.each([
  { environmentId: EnvironmentId.make("wrong-environment") },
  { projectId: ProjectId.make("wrong-project") },
  { threadId: ThreadId.make("wrong-thread") },
  { kind: "thread" as const },
])("does not persist a mismatched launch confirmation: %j", (change) =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const sql = yield* SqlClient.SqlClient;
    const stream = yield* bridge.listen("client-1");
    const first = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    const ask = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    expect(yield* bridge.claim("client-1", { ...destination, requestId: ask.requestId })).toBe(
      true,
    );
    yield* bridge.fulfill("client-1", {
      requestId: ask.requestId,
      op: "launch",
      result: { ...launched, ...change },
    });
    expect(yield* Fiber.join(first).pipe(Effect.flip)).toBeInstanceOf(
      CrossEnvironmentLaunchUncertain,
    );
    expect(yield* sql`SELECT result_json FROM cross_environment_launches`).toEqual([
      { result_json: null },
    ]);
    const retried = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    const retry = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    expect(yield* bridge.claim("client-1", { ...destination, requestId: retry.requestId })).toBe(
      true,
    );
    yield* bridge.fulfill("client-1", {
      requestId: retry.requestId,
      op: "launch",
      result: launched,
    });
    expect(yield* Fiber.join(retried)).toEqual(launched);
  }).pipe(provideBridge),
);

it.effect.each([
  { message: "new work" },
  { title: "A different task" },
  { runtimeMode: "approval-required" as const },
  { target: { kind: "load_balanced" as const } },
])("rejects changed parameters after a completed launch: %j", (change) =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const stream = yield* bridge.listen("client-1");
    const first = yield* bridge.askLaunch(launchInput).pipe(Effect.forkScoped);
    const ask = Option.getOrThrow(yield* Stream.runHead(Stream.take(stream, 1)));
    yield* bridge.claim("client-1", { ...destination, requestId: ask.requestId });
    yield* bridge.fulfill("client-1", { requestId: ask.requestId, op: "launch", result: launched });
    yield* Fiber.join(first);
    expect(yield* bridge.askLaunch({ ...launchInput, ...change }).pipe(Effect.flip)).toMatchObject({
      _tag: "CrossEnvironmentRequestConflict",
      commandId: launchInput.commandId,
    });
  }).pipe(provideBridge),
);
