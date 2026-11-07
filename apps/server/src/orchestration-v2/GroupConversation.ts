import type {
  MessageId,
  OrchestrationV2Run,
  OrchestrationV2ThreadGroup,
  OrchestrationV2ThreadGroupMember,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";

/** An eval decides parallel or serial. This is the one line it changes. */
export const GROUP_PARALLEL = true;

export type GroupMember = OrchestrationV2ThreadGroupMember;
export type GroupTurnOutcome =
  | { readonly type: "pass" }
  | { readonly type: "address_user" }
  | { readonly type: "address"; readonly handles: ReadonlyArray<string> }
  | { readonly type: "plain" };

/** One thing said on the public record. */
export interface GroupEntry {
  readonly ordinal: number;
  readonly runOrdinal: number;
  readonly speaker: GroupMember | "user";
  readonly label: string;
  readonly model: string | null;
  readonly text: string;
  readonly messageId: MessageId | null;
}

export interface GroupWave {
  readonly start: ReadonlyArray<GroupMember>;
  readonly close?: "settled" | "budget";
}

const HANDLE_TOKEN = /^@[a-z0-9][a-z0-9._-]*$/i;
export const USER_HANDLE = "user";
export const PASS_REPLY = "PASS";

export const seatedMembers = (group: OrchestrationV2ThreadGroup): ReadonlyArray<GroupMember> => [
  "primary",
  ...group.seats.filter((seat) => seat.status === "seated").map((seat) => seat.threadId),
];

/** `@` tokens in prose are prose. Only a final line made entirely of tokens addresses anyone. */
export function readTurnOutcome(text: string): GroupTurnOutcome {
  const trimmed = text.trim();
  if (trimmed === PASS_REPLY) return { type: "pass" };
  const finalLine = trimmed.split("\n").at(-1)?.trim() ?? "";
  const tokens = finalLine.split(/\s+/);
  if (finalLine === "" || !tokens.every((token) => HANDLE_TOKEN.test(token))) {
    return { type: "plain" };
  }
  const handles = tokens.map((token) => token.slice(1).toLowerCase());
  const named = handles.filter((handle) => handle !== USER_HANDLE);
  return named.length === 0 ? { type: "address_user" } : { type: "address", handles: named };
}

const memberForHandle = (
  group: OrchestrationV2ThreadGroup,
  handle: string,
): GroupMember | undefined =>
  handle === group.primary.handle || handle === "primary"
    ? "primary"
    : group.seats.find((seat) => seat.status === "seated" && seat.handle === handle)?.threadId;

/** A user's words reach members through dispatch, so only a member's words can wake anyone here. */
export function wakes(
  entry: Pick<GroupEntry, "speaker" | "text">,
  mode: NonNullable<OrchestrationV2ThreadGroup["discussion"]>["mode"],
  group: OrchestrationV2ThreadGroup,
): ReadonlyArray<GroupMember> {
  if (entry.speaker === "user") return [];
  const outcome = readTurnOutcome(entry.text);
  switch (outcome.type) {
    case "pass":
    case "address_user":
      return [];
    case "address":
      return outcome.handles.flatMap((handle) => {
        const member = memberForHandle(group, handle);
        return member === undefined || member === entry.speaker ? [] : [member];
      });
    case "plain":
      return mode === "everyone"
        ? seatedMembers(group).filter((member) => member !== entry.speaker)
        : [];
  }
}

export const planWave = (
  group: OrchestrationV2ThreadGroup,
  unseen: (member: GroupMember) => ReadonlyArray<GroupEntry>,
  activeMembers: ReadonlyArray<GroupMember>,
): GroupWave => {
  const { discussion } = group;
  if (discussion === null) return { start: [] };
  const members = seatedMembers(group);
  const closedByMember = members.some((member) =>
    unseen(member).some(
      (entry) => entry.speaker !== "user" && readTurnOutcome(entry.text).type === "address_user",
    ),
  );
  if (closedByMember) return { start: [], close: "settled" };
  if (activeMembers.length > 0) return { start: [] };
  const woken = members.filter((member) =>
    unseen(member).some((entry) => wakes(entry, discussion.mode, group).includes(member)),
  );
  if (woken.length === 0) return { start: [], close: "settled" };
  if (discussion.turnsLeft === 0) return { start: [], close: "budget" };
  const allowed = woken.slice(0, discussion.turnsLeft);
  return { start: GROUP_PARALLEL ? allowed : allowed.slice(0, 1) };
};

type RunRow = Pick<
  OrchestrationV2Run,
  | "id"
  | "ordinal"
  | "status"
  | "publication"
  | "modelSelection"
  | "groupThrough"
  | "activeAttemptId"
>;

const isSettledStatus = (status: OrchestrationV2Run["status"]) =>
  status === "completed" || status === "failed" || status === "interrupted";

const isOpenStatus = (status: OrchestrationV2Run["status"]) =>
  status === "preparing" ||
  status === "starting" ||
  status === "running" ||
  status === "waiting" ||
  status === "queued";

/**
 * The public record as members read it. A member's mid-turn narration is not a reply, so the
 * primary contributes only its last message, and only once its run settles. `settledThrough` stops
 * below any row still changing: taking a cursor above one would lose it when it finishes.
 */
export function groupEntries(input: {
  readonly group: OrchestrationV2ThreadGroup;
  readonly runs: ReadonlyArray<RunRow>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): { readonly entries: ReadonlyArray<GroupEntry>; readonly settledThrough: number } {
  const { group } = input;
  const runs = new Map(input.runs.map((run) => [run.id, run]));
  const finalPrimaryRows = new Map<OrchestrationV2Run["id"], OrchestrationV2TurnItem>();
  const entries: Array<GroupEntry> = [];
  let highest = 0;
  let lowestOpen = Number.POSITIVE_INFINITY;
  for (const item of input.turnItems) {
    if (item.runId === null || item.parentItemId !== null) continue;
    const run = runs.get(item.runId);
    if (run === undefined || run.status === "rolled_back" || run.status === "cancelled") continue;
    if (item.type === "user_message") {
      if (run.status === "queued") continue;
      highest = Math.max(highest, item.ordinal);
      entries.push({
        ordinal: item.ordinal,
        runOrdinal: run.ordinal,
        speaker: "user",
        label: "User",
        model: null,
        text: item.text,
        messageId: item.messageId,
      });
      continue;
    }
    if (item.type !== "assistant_message" || item.text.trim().length === 0) continue;
    const { publication } = run;
    if (publication?.type === "peer_reply") {
      highest = Math.max(highest, item.ordinal);
      entries.push({
        ordinal: item.ordinal,
        runOrdinal: run.ordinal,
        speaker: publication.seatThreadId,
        label: item.speaker?.label ?? run.modelSelection.model,
        model: item.speaker?.model ?? run.modelSelection.model,
        text: item.text,
        messageId: null,
      });
      continue;
    }
    if (isOpenStatus(run.status)) {
      lowestOpen = Math.min(lowestOpen, item.ordinal);
      continue;
    }
    if (!isSettledStatus(run.status)) continue;
    highest = Math.max(highest, item.ordinal);
    const previous = finalPrimaryRows.get(run.id);
    if (previous === undefined || previous.ordinal < item.ordinal) {
      finalPrimaryRows.set(run.id, item);
    }
  }
  for (const item of finalPrimaryRows.values()) {
    if (item.type !== "assistant_message" || item.runId === null) continue;
    const run = runs.get(item.runId);
    if (run === undefined) continue;
    const { model } = run.modelSelection;
    entries.push({
      ordinal: item.ordinal,
      runOrdinal: run.ordinal,
      speaker: "primary",
      label: model === group.primary.model ? group.primary.label : model,
      model,
      text: item.text,
      messageId: null,
    });
  }
  return {
    entries: entries.toSorted((left, right) => left.ordinal - right.ordinal),
    settledThrough: Math.min(highest, lowestOpen - 1),
  };
}

/** Words before the latest user message are history. They inform a delta but wake nobody. */
export function wakeFloorRunOrdinal(entries: ReadonlyArray<GroupEntry>): number {
  return entries.findLast((entry) => entry.speaker === "user")?.runOrdinal ?? 0;
}

const countsAsAttempt = (run: Pick<RunRow, "status">) =>
  run.status !== "rolled_back" && run.status !== "cancelled";

/** The newest run this member was asked to answer. A failed turn counts, so it is not re-woken. */
export function seatWakeCursor(
  seat: OrchestrationV2ThreadGroup["seats"][number],
  seatRuns: ReadonlyArray<Pick<RunRow, "status" | "groupThrough">>,
): number {
  return seatRuns.reduce(
    (cursor, run) =>
      countsAsAttempt(run) && run.groupThrough !== undefined
        ? Math.max(cursor, run.groupThrough)
        : cursor,
    seat.joinedThrough,
  );
}

/** The newest ordinal a provider took, or undefined before a seat's first turn reaches one. */
export function seatDeliveredCursor(
  seat: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
): number | undefined {
  let cursor: number | undefined;
  for (const run of seat.runs) {
    if (run.groupThrough === undefined || !countsAsAttempt(run)) continue;
    const neverAccepted =
      run.status === "failed" &&
      !seat.providerTurns.some((turn) => turn.runAttemptId === run.activeAttemptId);
    if (neverAccepted) continue;
    cursor = Math.max(cursor ?? 0, run.groupThrough);
  }
  return cursor;
}

export const primaryWakeCursor = (runs: ReadonlyArray<RunRow>) =>
  runs.reduce(
    (cursor, run) =>
      run.publication === undefined && countsAsAttempt(run)
        ? Math.max(cursor, run.ordinal)
        : cursor,
    0,
  );

/** What a member has not seen. Neither form ever includes the member's own words. */
export function unseenFor(
  member: GroupMember,
  entries: ReadonlyArray<GroupEntry>,
  cursor: number,
): ReadonlyArray<GroupEntry> {
  return entries.filter(
    (entry) =>
      entry.speaker !== member &&
      (member === "primary" ? entry.runOrdinal > cursor : entry.ordinal > cursor),
  );
}

/** Whether the member's own runs hold the barrier. Queued runs start on their own. */
export const hasOpenRun = (runs: ReadonlyArray<Pick<RunRow, "status" | "publication">>) =>
  runs.some((run) => run.publication === undefined && isOpenStatus(run.status));

/** The last thing a run said, which is what a seat publishes. */
export function finalReplyText(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  runId: OrchestrationV2Run["id"],
): string | null {
  let latest: Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }> | undefined;
  for (const item of turnItems) {
    if (item.type !== "assistant_message" || item.runId !== runId || item.parentItemId !== null) {
      continue;
    }
    if (item.text.trim().length === 0) continue;
    if (latest === undefined || latest.ordinal < item.ordinal) latest = item;
  }
  return latest?.text ?? null;
}

/** Whether this settled seat run should appear on the visible thread. */
export function seatRunPublishes(
  seat: OrchestrationV2ThreadGroup["seats"][number],
  run: Pick<RunRow, "status" | "groupThrough">,
): boolean {
  return (
    seat.status === "seated" &&
    isSettledStatus(run.status) &&
    run.groupThrough !== undefined &&
    run.groupThrough > seat.joinedThrough
  );
}

export const seatForThread = (
  group: OrchestrationV2ThreadGroup | null | undefined,
  threadId: ThreadId,
) => group?.seats.find((seat) => seat.threadId === threadId);
