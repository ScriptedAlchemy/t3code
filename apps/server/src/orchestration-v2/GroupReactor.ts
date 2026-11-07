import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadGroup,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";

import { forkParked } from "../serverActivation.ts";
import { finalReplyText, seatForThread, seatRunPublishes } from "./GroupConversation.ts";
import { groupSeatFailedNotice } from "./GroupPrompt.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class GroupReactor extends Context.Service<
  GroupReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Finishes whatever a crash left between a run settling and the next wave. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/GroupReactor") {}

type Seat = OrchestrationV2ThreadGroup["seats"][number];

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const publishSeatRun = Effect.fnUntraced(function* (
    parent: OrchestrationV2AppThread,
    seat: Seat,
    run: OrchestrationV2Run,
    text: string,
  ) {
    yield* engine.dispatch({
      type: "thread.group.publish",
      commandId: CommandId.make(`server:group-publish:${run.id}`),
      threadId: parent.id,
      status: run.status === "completed" ? "completed" : "interrupted",
      text,
      entry: {
        type: "peer_reply",
        seatThreadId: seat.threadId,
        seatRunId: run.id,
        speaker: { label: seat.label, model: run.modelSelection.model },
        modelSelection: run.modelSelection,
      },
    });
  });

  const advance = (threadId: ThreadId, cause: string) =>
    engine.dispatch({
      type: "thread.group.advance",
      commandId: CommandId.make(`server:group-advance:${threadId}:${cause}`),
      threadId,
    });

  const publishPending = Effect.fnUntraced(function* (
    parent: OrchestrationV2AppThread,
    seat: Seat,
    runId?: OrchestrationV2Run["id"],
  ) {
    const { runs, turnItems } = yield* projections.getThreadRecords(
      seat.threadId,
      ["runs", "turnItems"],
      {
        turnItemTypes: ["assistant_message", "error"],
        ...(runId === undefined ? {} : { turnItemRunIds: [runId] }),
      },
    );
    for (const run of runs) {
      if ((runId !== undefined && run.id !== runId) || !seatRunPublishes(seat, run)) continue;
      const text = finalReplyText(turnItems, run.id);
      if (text !== null) {
        yield* publishSeatRun(parent, seat, run, text);
      } else if (run.status === "failed") {
        yield* engine.dispatch({
          type: "thread.group.notice",
          commandId: CommandId.make(`server:group-seat-failed:${run.id}`),
          threadId: parent.id,
          message: groupSeatFailedNotice(
            seat.label,
            latestRootProviderFailure(run, turnItems)?.message,
          ),
        });
      }
    }
  });

  const onRunSettled = Effect.fnUntraced(function* (
    threadId: ThreadId,
    runId: OrchestrationV2Run["id"],
    cause: string,
  ) {
    const thread = yield* projections.getThread(threadId);
    const parentId = thread.lineage.sideChat === true ? thread.lineage.parentThreadId : null;
    if (parentId !== null) {
      const parent = yield* projections.getThread(parentId);
      const seat = seatForThread(parent.group, threadId);
      if (seat === undefined) return;
      yield* publishPending(parent, seat, runId);
      yield* advance(parent.id, cause);
      return;
    }
    if (thread.group?.status === "active") yield* advance(thread.id, cause);
  });

  // Runs for every domain event; most return on the first check.
  const handle: GroupReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "run.updated") {
        const { status } = event.payload;
        // A cancelled run says nothing to publish, but it may be the last thing a wave waited on.
        if (
          status !== "completed" &&
          status !== "failed" &&
          status !== "interrupted" &&
          status !== "cancelled"
        ) {
          return;
        }
        yield* onRunSettled(event.threadId, event.payload.id, event.id);
        return;
      }
      if (event.type === "thread.deleted") {
        const parentId = event.payload.lineage.parentThreadId;
        if (parentId === null || event.payload.lineage.sideChat !== true) return;
        const parent = yield* projections.getThread(parentId);
        if (parent.deletedAt !== null) return;
        if (seatForThread(parent.group, event.threadId)?.status !== "seated") return;
        yield* engine.dispatch({
          type: "thread.group.remove",
          commandId: CommandId.make(`server:group-remove:${event.id}`),
          threadId: parentId,
          seatThreadId: event.threadId,
        });
        return;
      }
      if (event.type !== "thread.group-updated") return;
      const { group } = event.payload;
      if (group?.status === "active" && group.discussion?.delivering.length === 0) {
        yield* advance(event.threadId, event.id);
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("advancing a thread group failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const sweep: GroupReactor["Service"]["sweep"] = Effect.gen(function* () {
    const threadIds = yield* projections.getActiveGroupThreadIds();
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function* () {
          const parent = yield* projections.getThread(threadId);
          const group = parent.group;
          if (group?.status !== "active") return;
          yield* Effect.forEach(
            group.seats.filter((seat) => seat.status === "seated"),
            (seat) => publishPending(parent, seat),
            { discard: true },
          );
          const now = yield* DateTime.now;
          yield* advance(threadId, `sweep:${DateTime.toEpochMillis(now)}`);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("resuming a thread group failed", { threadId, cause }),
          ),
        ),
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("sweeping thread groups failed", { cause })),
    Effect.withSpan("GroupReactor.sweep"),
  );

  // The sequence is read before the sweep, so anything that commits behind the sweep's reads replays.
  const start: GroupReactor["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        const afterSequence = yield* engine.getLatestEventSequence();
        yield* sweep;
        yield* Stream.runForEach(engine.streamDomainEventsAfter(afterSequence), handle);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread group event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle, sweep } satisfies GroupReactor["Service"];
});

export const layer = Layer.effect(GroupReactor, make);
