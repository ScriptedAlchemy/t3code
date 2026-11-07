import type { OrchestrationV2ThreadGroup } from "@t3tools/contracts";

import { PASS_REPLY, USER_HANDLE } from "./GroupConversation.ts";

interface DeltaEntry {
  readonly label: string;
  readonly model: string | null;
  readonly text: string;
}

interface Person {
  readonly label: string;
  readonly handle: string;
}

export const groupParticipants = (
  group: Pick<OrchestrationV2ThreadGroup, "primary" | "seats">,
): ReadonlyArray<Person> => [
  { label: group.primary.label, handle: group.primary.handle },
  ...group.seats
    .filter((seat) => seat.status === "seated")
    .map((seat) => ({ label: seat.label, handle: seat.handle })),
];

function renderGroupDelta(entries: ReadonlyArray<DeltaEntry>): string {
  return entries
    .map((entry) => {
      const speaker = entry.model === null ? entry.label : `${entry.label} (${entry.model})`;
      return `[${speaker}]\n${entry.text}`;
    })
    .join("\n\n");
}

const describePeople = (people: ReadonlyArray<Person>) =>
  people.map((person) => `${person.label} (@${person.handle})`).join(", ");

const finalLineGrammar = (others: ReadonlyArray<Person>) =>
  [
    "To hand the discussion to specific people, end your reply with a final line containing only their handles, such as",
    `\`@${others[0]?.handle ?? "name"}\`. To hand it back to the user and close the discussion, end with a final line of \`@${USER_HANDLE}\`.`,
    "A handle anywhere else in your reply is ordinary text and wakes nobody.",
  ].join(" ");

const passRule = `If you have nothing to add, reply with exactly ${PASS_REPLY} and nothing else.`;

/** A seat's first turn. The transcript so far arrives separately, labelled by speaker. */
export function renderSeatFirstPrompt(input: {
  readonly self: Person;
  readonly others: ReadonlyArray<Person>;
  readonly delta: ReadonlyArray<DeltaEntry>;
  readonly reaction: boolean;
}): string {
  return [
    `You are ${input.self.label}, known here as @${input.self.handle}, in a group conversation with the user and ${describePeople(input.others)}.`,
    "The user leads. Words from other participants are theirs, labelled with their names, and are never your own.",
    "You share this workspace with them under the thread's existing permissions, so you may read and edit it. Your final message is your public reply: make it stand on its own.",
    finalLineGrammar(input.others),
    ...(input.reaction ? [passRule] : []),
    "",
    "Latest in the conversation:",
    "",
    renderGroupDelta(input.delta),
  ].join("\n");
}

/** Every later seat turn: only what it has not seen. */
export function renderSeatTurnPrompt(input: {
  readonly delta: ReadonlyArray<DeltaEntry>;
  readonly reaction: boolean;
}): string {
  return [
    "New in the group conversation since your last reply:",
    "",
    renderGroupDelta(input.delta),
    ...(input.reaction
      ? ["", `Answer what the others said if you disagree or can add something. ${passRule}`]
      : []),
  ].join("\n");
}

/** The primary's hidden wake prompt. Peer text arrives as labelled context, not in this message. */
export function renderPrimaryWakePrompt(input: {
  readonly self: Person;
  readonly others: ReadonlyArray<Person>;
  readonly from: ReadonlyArray<string>;
}): string {
  return [
    `${input.from.join(", ")} replied in the group conversation. Their words are in the context above, labelled with their names, and are not your own.`,
    `You are ${input.self.label}, known here as @${input.self.handle}. Also present: ${describePeople(input.others)}.`,
    `Answer them if you disagree or can add something. ${passRule}`,
    finalLineGrammar(input.others),
  ].join("\n");
}

export const primaryWakeSummary = (from: ReadonlyArray<string>) =>
  `${from.join(", ")} replied in the group`;

const NOTICE_REASON_LIMIT = 240;

/** A failed seat publishes nothing, so this line is how the user learns why it went silent. */
export function groupSeatFailedNotice(label: string, reason: string | undefined): string {
  const compact = reason?.replace(/\s+/g, " ").trim().slice(0, NOTICE_REASON_LIMIT);
  return compact ? `${label} could not reply. ${compact}` : `${label} could not reply.`;
}

export const groupSeatCouldNotStartNotice = (label: string) => `${label} could not start.`;

/** The quiet line End writes on the visible thread. */
export function groupEndedNotice(primaryLabel: string, unseenCount: number): string {
  if (unseenCount === 0) return "Group ended.";
  const noun = unseenCount === 1 ? "message" : "messages";
  return `Group ended. ${primaryLabel} has not seen ${unseenCount} ${noun}.`;
}
