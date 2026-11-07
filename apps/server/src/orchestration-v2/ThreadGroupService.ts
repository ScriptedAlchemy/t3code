import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2AppThread,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ThreadGroup,
  ThreadId,
  ThreadGroupCommandError,
  ThreadGroupDisabledError,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveProjectProviderInstanceEnabled } from "@t3tools/contracts/settings";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";

const isDispatchError = Schema.is(Orchestrator.OrchestratorDispatchError);

interface Actor {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

type ThreadGroupError = ThreadGroupCommandError | ThreadGroupDisabledError;

/** The one way into a thread group, for every transport. */
export class ThreadGroupService extends Context.Service<
  ThreadGroupService,
  {
    readonly status: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<OrchestrationV2ThreadGroup | null, ThreadGroupCommandError>;
    readonly invite: (
      input: Actor & {
        readonly threadId: ThreadId;
        readonly modelSelection: ModelSelection;
      },
    ) => Effect.Effect<OrchestrationV2ThreadGroup, ThreadGroupError>;
    readonly remove: (input: {
      readonly threadId: ThreadId;
      readonly seatThreadId: ThreadId;
    }) => Effect.Effect<OrchestrationV2ThreadGroup, ThreadGroupCommandError>;
    readonly end: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<OrchestrationV2ThreadGroup, ThreadGroupCommandError>;
    readonly stop: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<OrchestrationV2ThreadGroup, ThreadGroupCommandError>;
    /** Says something to the group on the caller's behalf. `to` lists handles; absent is everyone. */
    readonly discuss: (
      input: Actor & {
        readonly threadId: ThreadId;
        readonly text: string;
        readonly to?: ReadonlyArray<string> | undefined;
      },
    ) => Effect.Effect<OrchestrationV2ThreadGroup, ThreadGroupCommandError>;
  }
>()("t3/orchestration-v2/ThreadGroupService") {}

/** A model's name from its provider's catalog, or its slug when the catalog does not list it. */
function groupModelLabel(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): string {
  const model = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.slug === selection.model);
  return model?.shortName ?? model?.name ?? selection.model;
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const random = yield* SecureRandom.SecureRandom;

  // A refused command already says why in words a user can act on.
  const failed = (operation: string, threadId: ThreadId) => (cause: unknown) =>
    new ThreadGroupCommandError({
      operation,
      threadId,
      cause,
      ...(isDispatchError(cause) && typeof cause.cause === "string" ? { reason: cause.cause } : {}),
    });

  const newCommandId = (operation: string, threadId: ThreadId) =>
    random.uuidV4().pipe(
      Effect.map((uuid) => CommandId.make(`server:group-${operation}:${threadId}:${uuid}`)),
      Effect.mapError(failed(operation, threadId)),
    );

  const readThread = (operation: string, threadId: ThreadId) =>
    engine.getThreadRecords(threadId, []).pipe(
      Effect.map((records): OrchestrationV2AppThread => records.thread),
      Effect.mapError(failed(operation, threadId)),
    );

  const readGroup = Effect.fnUntraced(function* (operation: string, threadId: ThreadId) {
    const thread = yield* readThread(operation, threadId);
    if (thread.group == null) {
      return yield* new ThreadGroupCommandError({
        operation,
        threadId,
        reason: "This thread has no group.",
      });
    }
    return thread.group;
  });

  const status: ThreadGroupService["Service"]["status"] = Effect.fn("ThreadGroupService.status")(
    function* ({ threadId }) {
      return (yield* readThread("status", threadId)).group ?? null;
    },
  );

  const invite: ThreadGroupService["Service"]["invite"] = Effect.fn("ThreadGroupService.invite")(
    function* (input) {
      const { threadId, modelSelection } = input;
      const current = yield* settings.getSettings.pipe(Effect.mapError(failed("invite", threadId)));
      if (!current.groupConversationsEnabled) {
        return yield* new ThreadGroupDisabledError({ threadId });
      }
      const thread = yield* readThread("invite", threadId);
      if (thread.lineage.sideChat === true || thread.lineage.relationshipToParent === "subagent") {
        return yield* new ThreadGroupCommandError({
          operation: "invite",
          threadId,
          reason: "A side chat or a subagent cannot host a group.",
        });
      }
      if (
        !resolveProjectProviderInstanceEnabled(current, thread.projectId, modelSelection.instanceId)
      ) {
        return yield* new ThreadGroupCommandError({
          operation: "invite",
          threadId,
          reason: "That model's provider is turned off for this project.",
        });
      }
      const providers = yield* registry.getProviders;
      const label = groupModelLabel(providers, modelSelection);
      const returning = yield* Effect.forEach(thread.group?.seats ?? [], (seat) =>
        engine.getThreadRecords(seat.threadId, []).pipe(
          Effect.map((records) =>
            records.thread.deletedAt === null &&
            records.thread.modelSelection.instanceId === modelSelection.instanceId &&
            records.thread.modelSelection.model === modelSelection.model &&
            seat.status === "left"
              ? seat
              : undefined,
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      );
      const seatThreadId =
        returning.find((seat) => seat !== undefined)?.threadId ??
        ThreadId.make(
          `thread:group-seat:${yield* random.uuidV4().pipe(Effect.mapError(failed("invite", threadId)))}`,
        );
      if (!returning.some((seat) => seat?.threadId === seatThreadId)) {
        yield* engine
          .dispatch({
            type: "thread.fork",
            commandId: yield* newCommandId("fork", threadId),
            sourceThreadId: threadId,
            targetThreadId: seatThreadId,
            sourcePoint: { type: "latest_stable" },
            title: label,
            sideChat: true,
            modelSelection,
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          })
          .pipe(Effect.mapError(failed("invite", threadId)));
      }
      yield* engine
        .dispatch({
          type: "thread.group.invite",
          commandId: yield* newCommandId("invite", threadId),
          threadId,
          seat: { threadId: seatThreadId, label },
          primaryLabel: groupModelLabel(providers, thread.modelSelection),
        })
        .pipe(Effect.mapError(failed("invite", threadId)));
      return yield* readGroup("invite", threadId);
    },
  );

  const remove: ThreadGroupService["Service"]["remove"] = Effect.fn("ThreadGroupService.remove")(
    function* ({ threadId, seatThreadId }) {
      yield* engine
        .dispatch({
          type: "thread.group.remove",
          commandId: yield* newCommandId("remove", threadId),
          threadId,
          seatThreadId,
        })
        .pipe(Effect.mapError(failed("remove", threadId)));
      return yield* readGroup("remove", threadId);
    },
  );

  const end: ThreadGroupService["Service"]["end"] = Effect.fn("ThreadGroupService.end")(function* ({
    threadId,
  }) {
    yield* engine
      .dispatch({
        type: "thread.group.end",
        commandId: yield* newCommandId("end", threadId),
        threadId,
      })
      .pipe(Effect.mapError(failed("end", threadId)));
    return yield* readGroup("end", threadId);
  });

  const stop: ThreadGroupService["Service"]["stop"] = Effect.fn("ThreadGroupService.stop")(
    function* ({ threadId }) {
      yield* engine
        .dispatch({
          type: "thread.stop",
          commandId: yield* newCommandId("stop", threadId),
          threadId,
          reason: "Stopped with the group",
        })
        .pipe(Effect.mapError(failed("stop", threadId)));
      return yield* readGroup("stop", threadId);
    },
  );

  const discuss: ThreadGroupService["Service"]["discuss"] = Effect.fn("ThreadGroupService.discuss")(
    function* (input) {
      const { threadId, to } = input;
      const group = yield* readGroup("discuss", threadId);
      if (group.status !== "active") {
        return yield* new ThreadGroupCommandError({
          operation: "discuss",
          threadId,
          reason: "This group has ended. Invite someone to start it again.",
        });
      }
      const members = to?.map((handle) => {
        const name = handle.replace(/^@/, "").toLowerCase();
        if (name === group.primary.handle || name === "primary") return "primary" as const;
        return group.seats.find((seat) => seat.status === "seated" && seat.handle === name)
          ?.threadId;
      });
      if (members?.includes(undefined)) {
        return yield* new ThreadGroupCommandError({
          operation: "discuss",
          threadId,
          reason: `Nobody in this group goes by ${to?.[members.indexOf(undefined)]}.`,
        });
      }
      const commandId = yield* newCommandId("discuss", threadId);
      yield* engine
        .dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make(`message:group-discuss:${commandId}`),
          text: input.text,
          attachments: [],
          groupAudience: members === undefined ? "everyone" : members.flatMap((row) => row ?? []),
          dispatchMode: { type: "queue_after_active" },
          deliveryIntent: "auto",
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        })
        .pipe(Effect.mapError(failed("discuss", threadId)));
      return yield* readGroup("discuss", threadId);
    },
  );

  return ThreadGroupService.of({ status, invite, remove, end, stop, discuss });
});

export const layer = Layer.effect(ThreadGroupService, make);
