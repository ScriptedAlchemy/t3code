import type {
  OrchestrationV2MessageSpeaker,
  OrchestrationV2Run,
  OrchestrationV2ThreadGroup,
  OrchestrationV2ThreadGroupMember,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";

import { threadRuntimeIsActive, type ThreadStructureTurnItem } from "./models.ts";

export type ThreadGroup = OrchestrationV2ThreadGroup;
export type ThreadGroupSeat = ThreadGroup["seats"][number];

/** Whom a message reaches. `primary` is whatever model the thread itself runs. */
export type ThreadGroupMember = OrchestrationV2ThreadGroupMember;

export interface ThreadGroupParticipant {
  readonly member: ThreadGroupMember;
  readonly handle: string;
  readonly label: string;
  readonly isPrimary: boolean;
}

type GroupLike = ThreadGroup | null | undefined;

export const isGroupActive = (group: GroupLike): group is ThreadGroup => group?.status === "active";

/** The server's own rule: a reply is a pass only when it says exactly `PASS`. */
export const isQuietPass = (text: string): boolean => text.trim() === "PASS";

const seatedSeats = (group: GroupLike): ReadonlyArray<ThreadGroupSeat> =>
  group?.seats.filter((seat) => seat.status === "seated") ?? [];

/** Seats run on hidden side chats of their own, so these are not ordinary side chats. */
export const isSeatedSeatThread = (group: GroupLike, threadId: ThreadId): boolean =>
  seatedSeats(group).some((seat) => seat.threadId === threadId);

/** The primary first, then each seated peer in invite order. */
export function groupParticipants(group: GroupLike): ReadonlyArray<ThreadGroupParticipant> {
  if (group == null) return [];
  return [
    {
      member: "primary",
      handle: group.primary.handle,
      label: group.primary.label,
      isPrimary: true,
    },
    ...seatedSeats(group).map((seat) => ({
      member: seat.threadId,
      handle: seat.handle,
      label: seat.label,
      isPrimary: false,
    })),
  ];
}

const sameHandle = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

const participantForHandle = (
  group: GroupLike,
  handle: string,
): ThreadGroupParticipant | undefined =>
  groupParticipants(group).find((participant) => sameHandle(participant.handle, handle));

/**
 * Who a composer prompt addresses. `@handle` tokens naming a seated member pick them, anything
 * else reaches everyone. Absent while no group is active, so an ordinary thread sends as before.
 */
export function groupAudienceForPrompt(
  group: GroupLike,
  prompt: string,
): "everyone" | ReadonlyArray<ThreadGroupMember> | undefined {
  if (!isGroupActive(group)) return undefined;
  const addressed = new Set<ThreadGroupMember>();
  for (const token of collectComposerInlineTokens(prompt)) {
    if (token.type !== "mention") continue;
    const participant = participantForHandle(group, token.value);
    if (participant !== undefined) addressed.add(participant.member);
  }
  return addressed.size === 0 ? "everyone" : [...addressed];
}

type SeatShell = {
  readonly id: ThreadId;
  readonly runtime: Parameters<typeof threadRuntimeIsActive>[0];
};

/** Seated seats whose own thread has an open run. */
export function runningSeats(
  group: GroupLike,
  shellOf: (threadId: ThreadId) => SeatShell | null | undefined,
): ReadonlyArray<ThreadGroupSeat> {
  return seatedSeats(group).filter((seat) =>
    threadRuntimeIsActive(shellOf(seat.threadId)?.runtime),
  );
}

/** Stop and the working state hold while a discussion is open, even when no run is. */
export const groupIsWorking = (group: GroupLike, seatsRunning: number): boolean =>
  group?.discussion != null || seatsRunning > 0;

export interface GroupRowSpeaker {
  readonly label: string;
  readonly model: string;
}

/**
 * Who spoke an assistant row. A peer's row carries its own `speaker`. The primary's rows keep
 * none, so they are named from the run, and only while a group exists to tell them apart.
 */
export function groupRowSpeaker(
  group: GroupLike,
  row: {
    readonly speaker?: OrchestrationV2MessageSpeaker | undefined;
    readonly run?: Pick<OrchestrationV2Run, "modelSelection"> | undefined;
  },
): GroupRowSpeaker | null {
  if (row.speaker !== undefined) return row.speaker;
  const selection = row.run?.modelSelection;
  if (group == null || selection === undefined) return null;
  return {
    label: selection.model === group.primary.model ? group.primary.label : selection.model,
    model: selection.model,
  };
}

/** "Astra had nothing to add", for a reply that was exactly `PASS`. */
export const quietPassLine = (label: string): string => `${label} had nothing to add`;

const ACTIVE_ITEM_STATUSES = new Set<string>(["pending", "running", "waiting"]);
const MAX_ACTIVITY_LENGTH = 48;

const short = (text: string) =>
  text.length > MAX_ACTIVITY_LENGTH ? `${text.slice(0, MAX_ACTIVITY_LENGTH - 1)}…` : text;

/** What an open seat run is doing now, from the newest unfinished item of that run. */
export function seatActivityLabel(
  items: ReadonlyArray<ThreadStructureTurnItem>,
  runId: RunId | null | undefined,
): string {
  const current = items
    .filter((item) => item.runId === runId && ACTIVE_ITEM_STATUSES.has(item.status))
    .reduce<ThreadStructureTurnItem | undefined>(
      (newest, item) => (newest === undefined || item.ordinal > newest.ordinal ? item : newest),
      undefined,
    );
  switch (current?.type) {
    case "command_execution":
      return `running ${short(current.input.trim().split("\n")[0] ?? "a command")}`;
    case "file_change":
      return `editing ${short(current.fileName)}`;
    case "file_search":
      return current.pattern ? `searching ${short(current.pattern)}` : "searching files";
    case "web_search":
      return "searching the web";
    case "approval_request":
      return "waiting for approval";
    case "user_input_request":
      return "waiting for an answer";
    case "reasoning":
      return "thinking";
    case "assistant_message":
      return "writing a reply";
    default:
      return "working";
  }
}
