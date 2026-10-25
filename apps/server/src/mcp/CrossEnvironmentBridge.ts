import {
  CrossEnvironmentLaunchRejected,
  CrossEnvironmentLaunchUncertain,
  PeerCatalogUnavailable,
  type ConnectedEnvironmentsResult,
  type CrossEnvironmentAsk,
  type CrossEnvironmentClaim,
  type CrossEnvironmentFailure,
  type CrossEnvironmentFulfillment,
  type CrossEnvironmentLaunchAsk,
  type CrossEnvironmentLaunchResult,
  type CrossEnvironmentListAsk,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

type LaunchWaitResult = ConnectedEnvironmentsResult | CrossEnvironmentLaunchResult;

type LaunchAskInput =
  | Omit<Extract<CrossEnvironmentLaunchAsk, { readonly kind: "run" }>, "requestId" | "op">
  | Omit<Extract<CrossEnvironmentLaunchAsk, { readonly kind: "thread" }>, "requestId" | "op">;

interface PendingAsk {
  readonly ask: CrossEnvironmentAsk;
  readonly connectionId: string;
  readonly deferred: Deferred.Deferred<LaunchWaitResult, CrossEnvironmentFailure>;
  claimedEnvironmentId: EnvironmentId | null;
}

interface Subscriber {
  readonly connectionId: string;
  readonly queue: Queue.Queue<CrossEnvironmentAsk>;
}

interface BridgeState {
  readonly subscriber: Subscriber | null;
  readonly subscribers: ReadonlyMap<string, Subscriber>;
  readonly pending: Map<string, PendingAsk>;
}

export class CrossEnvironmentBridge extends Context.Service<
  CrossEnvironmentBridge,
  {
    readonly hasSubscriber: Effect.Effect<boolean>;
    readonly listen: (
      connectionId: string,
    ) => Effect.Effect<Stream.Stream<CrossEnvironmentAsk>, never, Scope.Scope>;
    readonly subscribe: (connectionId: string) => Stream.Stream<CrossEnvironmentAsk>;
    readonly claim: (connectionId: string, body: CrossEnvironmentClaim) => Effect.Effect<boolean>;
    readonly fulfill: (
      connectionId: string,
      body: CrossEnvironmentFulfillment,
    ) => Effect.Effect<void>;
    readonly askList: (input: {
      readonly callerEnvironmentId: EnvironmentId;
      readonly sourceProjectId?: ProjectId;
    }) => Effect.Effect<ConnectedEnvironmentsResult, CrossEnvironmentFailure>;
    readonly askLaunch: (
      input: LaunchAskInput,
    ) => Effect.Effect<CrossEnvironmentLaunchResult, CrossEnvironmentFailure>;
  }
>()("t3/mcp/CrossEnvironmentBridge") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const state = yield* Ref.make<BridgeState>({
    subscriber: null,
    subscribers: new Map(),
    pending: new Map(),
  });

  const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);

  const unavailableResponse = ({ ask, claimedEnvironmentId }: PendingAsk) =>
    ask.op === "launch"
      ? new CrossEnvironmentLaunchUncertain({
          threadId: ask.threadId,
          environmentId:
            claimedEnvironmentId ??
            (ask.target.kind === "environment" ? ask.target.environmentId : null),
        })
      : new PeerCatalogUnavailable();

  const failPending = (pending: ReadonlyMap<string, PendingAsk>) =>
    Effect.forEach(
      pending.values(),
      (entry) => Deferred.fail(entry.deferred, unavailableResponse(entry)),
      { discard: true },
    );

  const listen = Effect.fn("CrossEnvironmentBridge.listen")(function* (connectionId: string) {
    const queue = yield* Queue.unbounded<CrossEnvironmentAsk>();
    yield* Effect.acquireRelease(
      withLock(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const subscribers = new Map(current.subscribers);
          const previousConnection = subscribers.get(connectionId);
          const subscriber = { connectionId, queue };
          subscribers.delete(connectionId);
          subscribers.set(connectionId, subscriber);
          yield* Ref.set(state, { subscriber, subscribers, pending: new Map() });
          // The previous client may already have launched on a peer. Replaying
          // can choose a different peer, outside the destination's deduplication.
          yield* failPending(current.pending);
          if (previousConnection !== undefined) {
            yield* Queue.shutdown(previousConnection.queue);
          }
        }),
      ),
      () =>
        withLock(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            if (current.subscribers.get(connectionId)?.queue === queue) {
              const subscribers = new Map(current.subscribers);
              subscribers.delete(connectionId);
              if (current.subscriber?.queue === queue) {
                yield* Ref.set(state, {
                  subscribers,
                  subscriber: [...subscribers.values()].at(-1) ?? null,
                  pending: new Map(),
                });
                yield* failPending(current.pending);
              } else {
                yield* Ref.set(state, { ...current, subscribers });
              }
            }
            yield* Queue.shutdown(queue);
          }),
        ),
    );
    return Stream.fromQueue(queue).pipe(
      Stream.filterEffect((ask) =>
        withLock(
          Ref.get(state).pipe(
            Effect.map(
              (current) =>
                current.subscriber?.queue === queue && current.pending.has(ask.requestId),
            ),
          ),
        ),
      ),
    );
  });

  const subscribe = (connectionId: string) => Stream.unwrap(listen(connectionId));

  const claim = Effect.fn("CrossEnvironmentBridge.claim")(function* (
    connectionId: string,
    body: CrossEnvironmentClaim,
  ) {
    return yield* withLock(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const pending = current.pending.get(body.requestId);
        if (
          pending === undefined ||
          pending.connectionId !== connectionId ||
          pending.ask.op !== "launch" ||
          pending.claimedEnvironmentId !== null ||
          pending.ask.callerEnvironmentId === body.environmentId ||
          (pending.ask.target.kind === "environment" &&
            pending.ask.target.environmentId !== body.environmentId)
        )
          return false;
        pending.claimedEnvironmentId = body.environmentId;
        return true;
      }),
    );
  });

  const fulfill = Effect.fn("CrossEnvironmentBridge.fulfill")(function* (
    connectionId: string,
    body: CrossEnvironmentFulfillment,
  ) {
    yield* withLock(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const pending = current.pending.get(body.requestId);
        if (pending === undefined || pending.connectionId !== connectionId) {
          return;
        }
        const outcome =
          "error" in body
            ? Effect.fail(body.error)
            : body.op === pending.ask.op
              ? Effect.succeed(body.result)
              : Effect.fail(new CrossEnvironmentLaunchRejected());
        const completed = yield* Deferred.complete(pending.deferred, outcome);
        if (completed) {
          current.pending.delete(body.requestId);
        }
      }),
    );
  });

  const wait = Effect.fn("CrossEnvironmentBridge.wait")(function* (ask: CrossEnvironmentAsk) {
    const deferred = yield* Deferred.make<LaunchWaitResult, CrossEnvironmentFailure>();
    return yield* Effect.acquireUseRelease(
      withLock(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (ask.op === "launch") {
            const existing = [...current.pending.values()].find(
              (entry) => entry.ask.op === "launch" && entry.ask.commandId === ask.commandId,
            );
            if (existing !== undefined) return { pending: existing, ownsRequest: false };
          }
          if (current.subscriber === null) {
            return yield* new PeerCatalogUnavailable();
          }
          const pending: PendingAsk = {
            ask,
            deferred,
            connectionId: current.subscriber.connectionId,
            claimedEnvironmentId: null,
          };
          current.pending.set(ask.requestId, pending);
          yield* Queue.offer(current.subscriber.queue, ask);
          return { pending, ownsRequest: true };
        }),
      ),
      ({ pending }) =>
        Deferred.await(pending.deferred).pipe(
          Effect.timeoutOrElse({
            duration: ask.op === "list" ? "15 seconds" : "1 minute",
            orElse: () => Effect.fail(unavailableResponse(pending)),
          }),
        ),
      ({ pending, ownsRequest }) =>
        ownsRequest
          ? withLock(
              Effect.gen(function* () {
                const current = yield* Ref.get(state);
                current.pending.delete(pending.ask.requestId);
                yield* Deferred.fail(pending.deferred, unavailableResponse(pending));
              }),
            )
          : Effect.void,
    );
  });

  const askList = Effect.fn("CrossEnvironmentBridge.askList")(function* (input: {
    readonly callerEnvironmentId: EnvironmentId;
    readonly sourceProjectId?: ProjectId;
  }) {
    const ask: CrossEnvironmentListAsk = {
      requestId: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
      op: "list",
      callerEnvironmentId: input.callerEnvironmentId,
      ...(input.sourceProjectId === undefined ? {} : { sourceProjectId: input.sourceProjectId }),
    };
    const result = yield* wait(ask);
    if ("threadId" in result) {
      return yield* new CrossEnvironmentLaunchRejected();
    }
    return result;
  });

  const askLaunch = Effect.fn("CrossEnvironmentBridge.askLaunch")(function* (
    input: LaunchAskInput,
  ) {
    const ask = {
      ...input,
      requestId: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
      op: "launch" as const,
    } satisfies CrossEnvironmentLaunchAsk;
    const result = yield* wait(ask);
    if (!("threadId" in result)) {
      return yield* new CrossEnvironmentLaunchRejected();
    }
    return result;
  });

  const hasSubscriber = withLock(
    Ref.get(state).pipe(Effect.map((current) => current.subscriber !== null)),
  );

  return CrossEnvironmentBridge.of({
    hasSubscriber,
    listen,
    subscribe,
    claim,
    fulfill,
    askList,
    askLaunch,
  });
});

export const layer = Layer.effect(CrossEnvironmentBridge, make);
