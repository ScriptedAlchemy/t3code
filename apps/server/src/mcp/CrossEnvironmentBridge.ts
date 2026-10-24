import {
  CrossEnvironmentLaunchRejected,
  PeerCatalogUnavailable,
  type ConnectedEnvironmentsResult,
  type CrossEnvironmentAsk,
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
  readonly deferred: Deferred.Deferred<LaunchWaitResult, CrossEnvironmentFailure>;
}

interface Subscriber {
  readonly queue: Queue.Queue<CrossEnvironmentAsk>;
}

interface BridgeState {
  readonly subscriber: Subscriber | null;
  readonly pending: Map<string, PendingAsk>;
}

export class CrossEnvironmentBridge extends Context.Service<
  CrossEnvironmentBridge,
  {
    readonly hasSubscriber: Effect.Effect<boolean>;
    readonly listen: () => Effect.Effect<Stream.Stream<CrossEnvironmentAsk>, never, Scope.Scope>;
    readonly subscribe: () => Stream.Stream<CrossEnvironmentAsk>;
    readonly fulfill: (body: CrossEnvironmentFulfillment) => Effect.Effect<void>;
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
  const state = yield* Ref.make<BridgeState>({ subscriber: null, pending: new Map() });

  const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);

  const failPending = (pending: ReadonlyMap<string, PendingAsk>) =>
    Effect.forEach(
      pending.values(),
      (entry) => Deferred.complete(entry.deferred, Effect.fail(new PeerCatalogUnavailable())),
      { discard: true },
    );

  const listen = Effect.fn("CrossEnvironmentBridge.listen")(function* () {
    const queue = yield* Queue.unbounded<CrossEnvironmentAsk>();
    const previous = yield* withLock(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        yield* Ref.set(state, { subscriber: { queue }, pending: current.pending });
        for (const entry of current.pending.values()) {
          yield* Queue.offer(queue, entry.ask);
        }
        return current.subscriber;
      }),
    );
    if (previous !== null) {
      yield* Queue.shutdown(previous.queue);
    }
    yield* Effect.addFinalizer(() =>
      withLock(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.subscriber?.queue !== queue) {
            return;
          }
          yield* Ref.set(state, { subscriber: null, pending: current.pending });
          yield* failPending(current.pending);
          current.pending.clear();
        }),
      ),
    );
    return Stream.fromQueue(queue);
  });

  const subscribe = () => Stream.unwrap(listen());

  const fulfill = Effect.fn("CrossEnvironmentBridge.fulfill")(function* (
    body: CrossEnvironmentFulfillment,
  ) {
    yield* withLock(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const pending = current.pending.get(body.requestId);
        if (pending === undefined) {
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

  const wait = (ask: CrossEnvironmentAsk) =>
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<LaunchWaitResult, CrossEnvironmentFailure>();
      const offered = yield* withLock(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.subscriber === null) {
            return false;
          }
          current.pending.set(ask.requestId, { ask, deferred });
          yield* Queue.offer(current.subscriber.queue, ask);
          return true;
        }),
      );
      if (!offered) {
        return yield* new PeerCatalogUnavailable();
      }
      return yield* Deferred.await(deferred);
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
    fulfill,
    askList,
    askLaunch,
  });
});

export const layer = Layer.effect(CrossEnvironmentBridge, make);
