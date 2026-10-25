import {
  CrossEnvironmentLaunchRejected,
  CrossEnvironmentLaunchDestination,
  CrossEnvironmentLaunchUncertain,
  PeerCatalogUnavailable,
  type ConnectedEnvironmentsResult,
  type CrossEnvironmentAsk,
  type CrossEnvironmentClaim,
  type CrossEnvironmentFailure,
  type CrossEnvironmentFulfillment,
  type CrossEnvironmentLaunchAsk,
  type CrossEnvironmentLaunchResult,
  type CrossEnvironmentRequestConflict,
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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CrossEnvironmentLaunchStore from "./CrossEnvironmentLaunchStore.ts";

type LaunchWaitResult = ConnectedEnvironmentsResult | CrossEnvironmentLaunchResult;

type LaunchAskInput =
  | Omit<
      Extract<CrossEnvironmentLaunchAsk, { readonly kind: "run" }>,
      "requestId" | "op" | "destination"
    >
  | Omit<
      Extract<CrossEnvironmentLaunchAsk, { readonly kind: "thread" }>,
      "requestId" | "op" | "destination"
    >;

interface PendingAsk {
  readonly ask: CrossEnvironmentAsk;
  readonly connectionId: string;
  readonly deferred: Deferred.Deferred<LaunchWaitResult, CrossEnvironmentFailure>;
  claimed: boolean;
  destination: CrossEnvironmentLaunchDestination | null;
}

const sameDestination = Schema.toEquivalence(CrossEnvironmentLaunchDestination);

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
  const launches = yield* CrossEnvironmentLaunchStore.CrossEnvironmentLaunchStore;
  const lock = yield* Semaphore.make(1);
  const state = yield* Ref.make<BridgeState>({
    subscriber: null,
    subscribers: new Map(),
    pending: new Map(),
  });

  const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);

  const unavailableResponse = ({ ask, destination }: Pick<PendingAsk, "ask" | "destination">) =>
    ask.op === "launch"
      ? new CrossEnvironmentLaunchUncertain({
          threadId: ask.threadId,
          environmentId:
            destination?.environmentId ??
            (ask.target.kind === "environment" ? ask.target.environmentId : null),
        })
      : new PeerCatalogUnavailable();

  const persist = <A>(
    pending: Pick<PendingAsk, "ask" | "destination">,
    effect: Effect.Effect<
      A,
      CrossEnvironmentRequestConflict | CrossEnvironmentLaunchStore.CrossEnvironmentLaunchStoreError
    >,
  ) =>
    effect.pipe(
      Effect.catchTags({
        CrossEnvironmentLaunchStoreError: (error) =>
          Effect.logWarning("Could not persist a cross-environment launch.", {
            operation: error.operation,
            commandId: error.commandId,
          }).pipe(Effect.andThen(Effect.fail(unavailableResponse(pending)))),
      }),
    );

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
          // Takeover cannot establish whether a previous remote dispatch is still in flight.
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
          pending.claimed ||
          pending.ask.callerEnvironmentId === body.environmentId ||
          (pending.ask.target.kind === "environment" &&
            pending.ask.target.environmentId !== body.environmentId)
        )
          return false;
        const destination = {
          environmentId: body.environmentId,
          projectId: body.projectId,
          modelSelection: body.modelSelection,
        };
        const recorded = yield* persist(
          pending,
          launches.claim(pending.ask.commandId, destination),
        ).pipe(Effect.catch(() => Effect.succeed(null)));
        if (recorded === null) return false;
        pending.destination = recorded;
        if (!sameDestination(recorded, destination)) return false;
        pending.claimed = true;
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
        const outcome = Effect.gen(function* () {
          if ("error" in body) {
            return yield* body.error._tag === "CrossEnvironmentLaunchUncertain"
              ? unavailableResponse(pending)
              : body.error;
          }
          if (body.op === "list" && pending.ask.op === "list") return body.result;
          if (body.op !== "launch" || pending.ask.op !== "launch") {
            return yield* new CrossEnvironmentLaunchRejected();
          }
          if (
            !pending.claimed ||
            pending.destination === null ||
            body.result.environmentId !== pending.destination.environmentId ||
            body.result.projectId !== pending.destination.projectId ||
            body.result.threadId !== pending.ask.threadId ||
            body.result.kind !== pending.ask.kind
          ) {
            return yield* unavailableResponse(pending);
          }
          return yield* persist(pending, launches.complete(pending.ask.commandId, body.result));
        });
        const completed = yield* Deferred.complete(pending.deferred, outcome);
        if (completed) {
          current.pending.delete(body.requestId);
        }
      }),
    );
  });

  const wait = Effect.fn("CrossEnvironmentBridge.wait")(function* (
    originalAsk: CrossEnvironmentAsk,
  ) {
    const deferred = yield* Deferred.make<LaunchWaitResult, CrossEnvironmentFailure>();
    return yield* Effect.acquireUseRelease(
      withLock(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          let ask = originalAsk;
          let destination: CrossEnvironmentLaunchDestination | null = null;
          if (ask.op === "launch") {
            const record = yield* persist({ ask, destination }, launches.reserve(ask));
            if (record.result !== null)
              return { _tag: "completed" as const, result: record.result };
            destination = record.destination;
            if (destination !== null) {
              ask = {
                ...ask,
                destination,
                target: { kind: "environment", environmentId: destination.environmentId },
              };
            }
            const commandId = ask.commandId;
            const existing = [...current.pending.values()].find(
              (entry) => entry.ask.op === "launch" && entry.ask.commandId === commandId,
            );
            if (existing !== undefined)
              return { _tag: "pending" as const, pending: existing, ownsRequest: false };
          }
          if (current.subscriber === null) {
            return yield* new PeerCatalogUnavailable();
          }
          const pending: PendingAsk = {
            ask,
            deferred,
            connectionId: current.subscriber.connectionId,
            destination,
            claimed: false,
          };
          current.pending.set(ask.requestId, pending);
          yield* Queue.offer(current.subscriber.queue, ask);
          return { _tag: "pending" as const, pending, ownsRequest: true };
        }),
      ),
      (entry) =>
        entry._tag === "completed"
          ? Effect.succeed(entry.result)
          : Deferred.await(entry.pending.deferred).pipe(
              Effect.timeoutOrElse({
                duration: originalAsk.op === "list" ? "15 seconds" : "1 minute",
                orElse: () => Effect.fail(unavailableResponse(entry.pending)),
              }),
            ),
      (entry) =>
        entry._tag === "pending" && entry.ownsRequest
          ? withLock(
              Effect.gen(function* () {
                const current = yield* Ref.get(state);
                current.pending.delete(entry.pending.ask.requestId);
                yield* Deferred.fail(entry.pending.deferred, unavailableResponse(entry.pending));
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

export const layer = Layer.effect(CrossEnvironmentBridge, make).pipe(
  Layer.provide(CrossEnvironmentLaunchStore.layer),
);
