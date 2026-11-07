import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadGroup,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  type GroupMember,
  type GroupWave,
  seatedMembers,
  USER_HANDLE,
} from "./GroupConversation.ts";

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
    ...(!isPeerReply && entry.context !== undefined ? { context: entry.context } : {}),
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
        ...(entry.context === undefined ? {} : { context: entry.context }),
        createdBy: entry.createdBy,
        creationSource: entry.creationSource,
      };
  return { run, message, turnItem };
}

type GroupMembershipCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.group.invite" | "thread.group.remove" | "thread.group.end" }
>;

/** "Claude Opus 4.8" reads as `opus`, since the vendor and version do not name who is speaking. */
export function handleFromLabel(label: string): string {
  const words = label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !/\d/.test(word) && word !== "claude");
  return (
    words[0] ??
    (label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") ||
      "peer")
  );
}

function uniqueHandle(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base) && base !== "primary" && base !== USER_HANDLE) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** Turn budget for one user message. */
const groupTurnBudget = (group: OrchestrationV2ThreadGroup) =>
  Math.min(2 * seatedMembers(group).length, 8);

const seatedSeatIds = (group: OrchestrationV2ThreadGroup) =>
  group.seats.filter((seat) => seat.status === "seated").map((seat) => seat.threadId);

export interface GroupMembershipDecision {
  readonly group: OrchestrationV2ThreadGroup;
  /** Seats to interrupt once this commits. */
  readonly stopSeats: ReadonlyArray<ThreadId>;
}

/** Applies a membership command. The orchestrator runs commands one at a time, so handles stay unique. */
export function decideGroupMembership(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly command: GroupMembershipCommand;
  /** The parent's newest turn item ordinal. */
  readonly latestItemOrdinal: number;
}): Result.Result<GroupMembershipDecision, string> {
  const { thread, command } = input;
  const group = thread.group ?? null;
  switch (command.type) {
    case "thread.group.invite": {
      const primaryHandle = handleFromLabel(command.primaryLabel);
      const base: OrchestrationV2ThreadGroup = group ?? {
        status: "active",
        primary: {
          model: thread.modelSelection.model,
          label: command.primaryLabel,
          handle: primaryHandle,
        },
        seats: [],
        discussion: null,
        closedBecause: null,
        closedAt: null,
      };
      const existing = base.seats.find((seat) => seat.threadId === command.seat.threadId);
      const taken = new Set([
        base.primary.handle,
        ...base.seats
          .filter((seat) => seat.threadId !== command.seat.threadId)
          .map((seat) => seat.handle),
      ]);
      const seat = {
        threadId: command.seat.threadId,
        label: existing?.label ?? command.seat.label,
        handle: existing?.handle ?? uniqueHandle(handleFromLabel(command.seat.label), taken),
        status: "seated" as const,
        joinedThrough: input.latestItemOrdinal,
      };
      return Result.succeed({
        group: {
          ...base,
          status: "active",
          seats:
            existing === undefined
              ? [...base.seats, seat]
              : base.seats.map((row) => (row.threadId === seat.threadId ? seat : row)),
        },
        stopSeats: [],
      });
    }
    case "thread.group.remove": {
      if (group === null) return Result.fail("This thread has no group.");
      const discussion = group.discussion;
      return Result.succeed({
        group: {
          ...group,
          seats: group.seats.map((seat) =>
            seat.threadId === command.seatThreadId ? { ...seat, status: "left" as const } : seat,
          ),
          discussion:
            discussion === null
              ? null
              : {
                  ...discussion,
                  delivering: discussion.delivering.filter(
                    (member) => member !== command.seatThreadId,
                  ),
                },
        },
        stopSeats: group.seats.some((seat) => seat.threadId === command.seatThreadId)
          ? [command.seatThreadId]
          : [],
      });
    }
    case "thread.group.end": {
      if (group === null) return Result.fail("This thread has no group.");
      return Result.succeed({
        group: {
          ...group,
          status: "ended",
          // A seat that returns does so one invite at a time, so nobody rejoins by accident.
          seats: group.seats.map((seat) => ({ ...seat, status: "left" as const })),
          discussion: null,
        },
        stopSeats: seatedSeatIds(group),
      });
    }
  }
}

/** Who a message reaches. A message reaches seats only through an active group. */
export function resolveGroupAudience(
  group: OrchestrationV2ThreadGroup,
  audience: "everyone" | ReadonlyArray<GroupMember> | undefined,
): {
  readonly mode: "everyone" | "direct";
  readonly includesPrimary: boolean;
  readonly seats: ReadonlyArray<ThreadId>;
} {
  const seated = seatedSeatIds(group);
  if (audience === undefined || audience === "everyone") {
    return { mode: "everyone", includesPrimary: true, seats: seated };
  }
  return {
    mode: "direct",
    includesPrimary: audience.includes("primary"),
    seats: seated.filter((seat) => audience.includes(seat)),
  };
}

/** A user message refills the budget, sets the mode, and pays for the members it reaches. */
export function groupAfterUserMessage(
  group: OrchestrationV2ThreadGroup,
  audience: ReturnType<typeof resolveGroupAudience>,
): OrchestrationV2ThreadGroup {
  const spent = audience.seats.length + (audience.includesPrimary ? 1 : 0);
  return {
    ...group,
    discussion: {
      mode: audience.mode,
      turnsLeft: Math.max(0, groupTurnBudget(group) - spent),
      delivering: audience.seats,
    },
    closedBecause: null,
  };
}

export function groupAfterWave(
  group: OrchestrationV2ThreadGroup,
  wave: GroupWave,
  now: DateTime.Utc,
): OrchestrationV2ThreadGroup {
  const { discussion } = group;
  if (discussion === null) return group;
  if (wave.close !== undefined) {
    return {
      ...group,
      discussion: null,
      closedBecause: wave.close,
      closedAt: DateTime.formatIso(now),
    };
  }
  if (wave.start.length === 0) return group;
  return {
    ...group,
    discussion: {
      ...discussion,
      turnsLeft: discussion.turnsLeft - wave.start.length,
      delivering: wave.start,
    },
  };
}

export const groupAfterDelivered = (
  group: OrchestrationV2ThreadGroup,
  member: GroupMember,
): OrchestrationV2ThreadGroup =>
  group.discussion === null || !group.discussion.delivering.includes(member)
    ? group
    : {
        ...group,
        discussion: {
          ...group.discussion,
          delivering: group.discussion.delivering.filter((row) => row !== member),
        },
      };

export const groupAfterStop = (
  group: OrchestrationV2ThreadGroup,
  now: DateTime.Utc,
): OrchestrationV2ThreadGroup =>
  group.discussion === null
    ? group
    : { ...group, discussion: null, closedBecause: "stopped", closedAt: DateTime.formatIso(now) };
