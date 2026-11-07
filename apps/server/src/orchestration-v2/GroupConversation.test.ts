import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadGroup,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import { decideGroupMembership, handleFromLabel } from "./ThreadGroupDecider.ts";
import {
  GROUP_PARALLEL,
  type GroupEntry,
  type GroupMember,
  groupEntries,
  planWave,
  readTurnOutcome,
  seatDeliveredCursor,
  seatRunPublishes,
  seatWakeCursor,
  unseenFor,
  wakeFloorRunOrdinal,
  wakes,
} from "./GroupConversation.ts";

const astra = ThreadId.make("thread:astra");
const opus = ThreadId.make("thread:opus");
const gone = ThreadId.make("thread:gone");

const seat = (threadId: ThreadId, handle: string, status: "seated" | "left" = "seated") => ({
  threadId,
  handle,
  label: handle,
  status,
  joinedAfterRun: 0,
});

const groupOf = (
  discussion: OrchestrationV2ThreadGroup["discussion"],
): OrchestrationV2ThreadGroup => ({
  status: "active",
  primary: { model: "fable-model", label: "Fable", handle: "fable" },
  seats: [seat(astra, "astra"), seat(opus, "opus"), seat(gone, "gone", "left")],
  discussion,
  closedBecause: null,
  closedAt: null,
});

const discussion = (mode: "everyone" | "direct", turnsLeft: number) => ({
  mode,
  turnsLeft,
  delivering: [],
});

const entry = (speaker: GroupMember | "user", text: string, ordinal = 1): GroupEntry => ({
  ordinal,
  runOrdinal: ordinal,
  speaker,
  label: "x",
  model: null,
  text,
  messageId: null,
});

describe("handleFromLabel", () => {
  it.each([
    ["Claude Opus 4.8", "opus"],
    ["Astra", "astra"],
    ["GPT-5.4", "gpt-5-4"],
    ["Sonnet 4.6 (1M)", "sonnet"],
    ["gpt-6-astra", "astra"],
    ["GPT-6-Luna", "luna"],
    ["Claude Haiku 5.5", "haiku"],
    ["4.8", "4-8"],
  ])("reads %j as %s", (label, handle) => {
    expect(handleFromLabel(label)).toBe(handle);
  });
});

describe("group membership labels", () => {
  const thread = {
    modelSelection: { instanceId: "codex", model: "same-model" },
    group: null,
  } as unknown as OrchestrationV2AppThread;
  const inviteSeat = (current: OrchestrationV2AppThread, id: string) => {
    const decided = decideGroupMembership({
      thread: current,
      seatLatestRunOrdinal: 0,
      command: {
        type: "thread.group.invite",
        commandId: CommandId.make(`invite:${id}`),
        threadId: ThreadId.make("thread:parent"),
        seat: { threadId: ThreadId.make(id), label: "Opus" },
        primaryLabel: "Opus",
      },
    });
    if (Result.isFailure(decided)) throw new Error(decided.failure);
    return { ...current, group: decided.success.group };
  };

  it("names members apart when the same model is invited again", () => {
    const once = inviteSeat(thread, "seat:one");
    const twice = inviteSeat(once, "seat:two");
    expect(twice.group?.primary.label).toBe("Opus");
    expect(twice.group?.seats.map((seat) => [seat.handle, seat.label])).toEqual([
      ["opus-2", "Opus 2"],
      ["opus-3", "Opus 3"],
    ]);
  });
});

describe("readTurnOutcome", () => {
  it.each([
    ["PASS", { type: "pass" }],
    ["  PASS\n", { type: "pass" }],
    ["PASS because nothing", { type: "plain" }],
    ["pass", { type: "plain" }],
    ["I agree.\n\n@astra", { type: "address", handles: ["astra"] }],
    ["I agree.\n@astra @Opus", { type: "address", handles: ["astra", "opus"] }],
    ["Done.\n@user", { type: "address_user" }],
    ["@user @astra", { type: "address", handles: ["astra"] }],
    ["Ask @astra about this.", { type: "plain" }],
    ["@astra should look at this", { type: "plain" }],
    ["@astra\nthen more words", { type: "plain" }],
    ["", { type: "plain" }],
  ] as const)("reads %j", (text, expected) => {
    expect(readTurnOutcome(text)).toEqual(expected);
  });
});

describe("wakes", () => {
  const group = groupOf(discussion("everyone", 4));

  it.each<
    [string, GroupMember | "user", string, "everyone" | "direct", ReadonlyArray<GroupMember>]
  >([
    ["final line handle", astra, "Thoughts.\n@opus", "direct", [opus]],
    ["final line names primary", astra, "Thoughts.\n@fable", "direct", ["primary"]],
    ["final line of two", "primary", "Thoughts.\n@astra @opus", "everyone", [astra, opus]],
    ["a member cannot wake itself", astra, "@astra", "everyone", []],
    ["a seat that left is gone", astra, "@gone", "everyone", []],
    ["an unknown handle", astra, "@nobody", "everyone", []],
    ["@user", astra, "All done.\n@user", "everyone", []],
    ["PASS", astra, "PASS", "everyone", []],
    ["plain in everyone", astra, "Plain.", "everyone", ["primary", opus]],
    ["plain from the primary", "primary", "Plain.", "everyone", [astra, opus]],
    ["plain in direct", astra, "Plain.", "direct", []],
    ["prose mention in everyone", astra, "Ask @opus.", "everyone", ["primary", opus]],
    ["prose mention in direct", astra, "Ask @fable.", "direct", []],
    ["the user wakes nobody here", "user", "Plain.\n@astra", "everyone", []],
  ])("%s", (_name, speaker, text, mode, expected) => {
    expect(wakes(entry(speaker, text), mode, group)).toEqual(expected);
  });
});

describe("planWave", () => {
  const none = () => [];
  const plain = (speaker: GroupMember) => entry(speaker, "Plain.");
  const others =
    (byMember: Partial<Record<GroupMember, ReadonlyArray<GroupEntry>>>) => (member: GroupMember) =>
      byMember[member] ?? [];

  it.each<
    [
      string,
      OrchestrationV2ThreadGroup["discussion"],
      (member: GroupMember) => ReadonlyArray<GroupEntry>,
      ReadonlyArray<GroupMember>,
      ReturnType<typeof planWave>,
    ]
  >([
    ["no discussion", null, () => [plain(astra)], [], { start: [] }],
    [
      "barrier while a member runs",
      discussion("everyone", 4),
      others({ primary: [plain(astra)] }),
      [opus],
      { start: [] },
    ],
    ["nothing wakes anyone", discussion("everyone", 4), none, [], { start: [], close: "settled" }],
    [
      "wakes everyone with an unseen reply, primary first",
      discussion("everyone", 4),
      others({ primary: [plain(astra)], [opus]: [plain(astra)], [astra]: [plain(opus)] }),
      [],
      { start: GROUP_PARALLEL ? ["primary", astra, opus] : ["primary"] },
    ],
    [
      "a spent budget closes with replies still unanswered",
      discussion("everyone", 0),
      others({ primary: [plain(astra)] }),
      [],
      { start: [], close: "budget" },
    ],
    [
      "budget caps the wave",
      discussion("everyone", 1),
      others({ primary: [plain(astra)], [opus]: [plain(astra)] }),
      [],
      { start: ["primary"] },
    ],
    [
      "direct mode: a plain reply wakes nobody",
      discussion("direct", 4),
      others({ primary: [plain(astra)] }),
      [],
      { start: [], close: "settled" },
    ],
    [
      "direct mode: a final line wakes that member",
      discussion("direct", 4),
      others({ primary: [entry(astra, "Over to you.\n@fable")] }),
      [],
      { start: ["primary"] },
    ],
    [
      "PASS closes when it was the only thing unseen",
      discussion("everyone", 4),
      others({ primary: [entry(astra, "PASS")] }),
      [],
      { start: [], close: "settled" },
    ],
    [
      "@user closes even while another member runs",
      discussion("everyone", 4),
      others({ primary: [entry(astra, "Finished.\n@user")] }),
      [opus],
      { start: [], close: "settled" },
    ],
    [
      "a user's words do not close through @user",
      discussion("everyone", 4),
      others({ primary: [entry("user", "Say @user")] }),
      [],
      { start: [], close: "settled" },
    ],
  ])("%s", (_name, open, unseen, active, expected) => {
    expect(planWave(groupOf(open), unseen, active)).toEqual(expected);
  });
});

const now = DateTime.makeUnsafe(0);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "fable-model",
};

const run = (
  id: string,
  ordinal: number,
  status: OrchestrationV2Run["status"],
  extra: Partial<OrchestrationV2Run> = {},
) =>
  ({
    id: RunId.make(id),
    ordinal,
    status,
    modelSelection,
    activeAttemptId: null,
    ...extra,
  }) as OrchestrationV2Run;

const itemBase = (runId: string, ordinal: number) => ({
  id: TurnItemId.make(`item:${ordinal}`),
  threadId: ThreadId.make("thread:parent"),
  runId: RunId.make(runId),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});

const assistant = (
  runId: string,
  ordinal: number,
  text: string,
  speaker?: { label: string; model: string },
): OrchestrationV2TurnItem => ({
  ...itemBase(runId, ordinal),
  type: "assistant_message",
  messageId: MessageId.make(`message:${ordinal}`),
  text,
  streaming: false,
  ...(speaker === undefined ? {} : { speaker }),
});

const user = (runId: string, ordinal: number, text: string): OrchestrationV2TurnItem => ({
  ...itemBase(runId, ordinal),
  type: "user_message",
  messageId: MessageId.make(`message:${ordinal}`),
  inputIntent: "turn_start",
  createdBy: "user",
  creationSource: "web",
  text,
  attachments: [],
});

describe("groupEntries", () => {
  const group = groupOf(discussion("everyone", 4));

  it("takes the primary's last message from a settled run and a peer's published reply", () => {
    const { entries, settledThrough } = groupEntries({
      group,
      runs: [
        run("run:1", 1, "completed"),
        run("run:2", 2, "completed", {
          publication: { type: "peer_reply", seatThreadId: astra, seatRunId: RunId.make("s") },
        }),
      ],
      turnItems: [
        user("run:1", 1, "Question"),
        assistant("run:1", 2, "Narrating"),
        assistant("run:1", 3, "Answer"),
        assistant("run:2", 4, "Peer answer", { label: "Astra", model: "astra-model" }),
      ],
    });
    expect(entries.map((row) => [row.ordinal, row.speaker, row.label, row.text])).toEqual([
      [1, "user", "User", "Question"],
      [3, "primary", "Fable", "Answer"],
      [4, astra, "Astra", "Peer answer"],
    ]);
    expect(settledThrough).toBe(4);
  });

  it("holds the cursor below a row still changing, and omits rewound runs", () => {
    const { entries, settledThrough } = groupEntries({
      group,
      runs: [
        run("run:1", 1, "rolled_back"),
        run("run:2", 2, "running"),
        run("run:3", 3, "completed", {
          publication: { type: "user_to_peers", seatThreadIds: [astra] },
        }),
      ],
      turnItems: [
        assistant("run:1", 1, "Rewound"),
        user("run:2", 2, "Question"),
        assistant("run:2", 3, "Streaming"),
        user("run:3", 4, "To the peers"),
      ],
    });
    expect(entries.map((row) => row.text)).toEqual(["Question", "To the peers"]);
    expect(settledThrough).toBe(2);
  });

  it("keeps the cursor below a running primary whose reply has not started", () => {
    const { entries, settledThrough } = groupEntries({
      group,
      runs: [
        run("run:1", 1, "running"),
        run("run:2", 2, "completed", {
          publication: { type: "peer_reply", seatThreadId: astra, seatRunId: RunId.make("s") },
        }),
      ],
      turnItems: [
        user("run:1", 1_000_001, "Question"),
        assistant("run:2", 2_000_001, "Peer answer", { label: "Astra", model: "astra-model" }),
      ],
    });
    expect(entries.map((row) => row.text)).toEqual(["Question", "Peer answer"]);
    expect(settledThrough).toBe(1_000_001);
  });

  it("names a primary that changed model by its slug, not the snapshot", () => {
    const { entries } = groupEntries({
      group,
      runs: [
        run("run:1", 1, "completed", {
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "other-model" },
        }),
      ],
      turnItems: [assistant("run:1", 1, "Answer")],
    });
    expect(entries[0]).toMatchObject({ label: "other-model", model: "other-model" });
  });
});

describe("what each member has not seen", () => {
  it("excludes a member's own words, using item ordinals for seats and runs for the primary", () => {
    const entries = [
      { ...entry("user", "u", 1), runOrdinal: 1 },
      { ...entry("primary", "p", 2), runOrdinal: 1 },
      { ...entry(astra, "a", 3), runOrdinal: 2 },
    ];
    expect(unseenFor(astra, entries, 1).map((row) => row.text)).toEqual(["p"]);
    expect(unseenFor("primary", entries, 1).map((row) => row.text)).toEqual(["a"]);
    expect(unseenFor(opus, entries, 2).map((row) => row.text)).toEqual(["a"]);
  });

  it("treats words before the latest user message as history", () => {
    const entries = [entry(astra, "old", 1), entry("user", "new", 2), entry(astra, "fresh", 3)];
    expect(wakeFloorRunOrdinal(entries)).toBe(2);
    expect(wakeFloorRunOrdinal([])).toBe(0);
  });

  it("wakes from attempts but delivers from what a provider took", () => {
    const failedBeforeTurn = run("run:1", 1, "failed", {
      groupThrough: 5,
      activeAttemptId: "attempt:1" as never,
    });
    const queued = run("run:2", 2, "queued", { groupThrough: 7 });
    const cancelled = run("run:3", 3, "cancelled", { groupThrough: 9 });
    expect(seatWakeCursor([failedBeforeTurn, queued, cancelled])).toBe(7);
    expect(seatWakeCursor([])).toBe(0);
    expect(
      seatDeliveredCursor({ runs: [failedBeforeTurn, cancelled], providerTurns: [] }),
    ).toBeUndefined();
    expect(seatDeliveredCursor({ runs: [failedBeforeTurn, queued], providerTurns: [] })).toBe(7);
  });

  it("publishes only runs delivered since the seat joined", () => {
    const joined = { ...seat(astra, "astra"), joinedAfterRun: 4 };
    expect(seatRunPublishes(joined, run("a", 5, "completed", { groupThrough: 1 }))).toBe(true);
    expect(seatRunPublishes(joined, run("b", 5, "interrupted", { groupThrough: 1 }))).toBe(true);
    expect(seatRunPublishes(joined, run("c", 4, "completed", { groupThrough: 9 }))).toBe(false);
    expect(seatRunPublishes(joined, run("d", 5, "completed"))).toBe(false);
    expect(seatRunPublishes(joined, run("e", 5, "running", { groupThrough: 1 }))).toBe(false);
    expect(
      seatRunPublishes(
        { ...joined, status: "left" },
        run("f", 5, "completed", { groupThrough: 1 }),
      ),
    ).toBe(false);
  });
});
