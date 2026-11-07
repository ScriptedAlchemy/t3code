import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ServerCommand,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as DateTime from "effect/DateTime";

type PublishCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.group.publish" }
>;

/** Ids come from the source of the words, so publishing the same words twice finds the same run. */
export function planGroupPublication(input: {
  readonly command: PublishCommand;
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "modelSelection">;
  readonly ordinal: number;
  readonly turnItemOrdinal: number;
  readonly now: DateTime.Utc;
}) {
  const { command, now } = input;
  const { entry } = command;
  const threadId = input.thread.id;
  const isPeerReply = entry.type === "peer_reply";
  const source = isPeerReply ? entry.seatRunId : entry.messageId;
  const runId = IdAllocator.derive.publicationRun({ threadId, source });
  const messageId = isPeerReply
    ? IdAllocator.derive.publicationMessage({ runId })
    : entry.messageId;
  const modelSelection = isPeerReply ? entry.modelSelection : input.thread.modelSelection;
  const attachments = isPeerReply ? [] : entry.attachments;
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: input.ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: messageId,
    rootNodeId: null,
    activeAttemptId: null,
    status: command.status,
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
    publication: isPeerReply
      ? { type: "peer_reply", seatThreadId: entry.seatThreadId, seatRunId: entry.seatRunId }
      : { type: "user_to_peers", seatThreadIds: entry.seatThreadIds },
  };
  const message: OrchestrationV2ConversationMessage = {
    createdBy: isPeerReply ? "agent" : entry.createdBy,
    creationSource: isPeerReply ? "server" : entry.creationSource,
    id: messageId,
    threadId,
    runId,
    nodeId: null,
    role: isPeerReply ? "assistant" : "user",
    text: command.text,
    attachments,
    streaming: false,
    createdAt: now,
    updatedAt: now,
  };
  const itemBase = {
    id: IdAllocator.derive.publicationTurnItem({ runId }),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.turnItemOrdinal,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId,
    text: command.text,
    attachments,
  } as const;
  const turnItem: OrchestrationV2TurnItem = isPeerReply
    ? { ...itemBase, type: "assistant_message", streaming: false, speaker: entry.speaker }
    : {
        ...itemBase,
        type: "user_message",
        inputIntent: "turn_start",
        createdBy: entry.createdBy,
        creationSource: entry.creationSource,
      };
  return { run, message, turnItem };
}
