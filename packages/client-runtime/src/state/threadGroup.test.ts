import { RunId, ThreadId, type OrchestrationV2ThreadGroup } from "@t3tools/contracts";

import type { ThreadStructureTurnItem } from "./models.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupAudienceForPrompt,
  groupParticipants,
  groupRowSpeaker,
  isQuietPass,
  isSeatedSeatThread,
  runningSeats,
  seatActivityLabel,
} from "./threadGroup.ts";

const astra = ThreadId.make("thread-astra");
const opus = ThreadId.make("thread-opus");

const group: OrchestrationV2ThreadGroup = {
  status: "active",
  primary: { model: "fable-5", label: "Fable", handle: "fable" },
  seats: [
    { threadId: astra, handle: "astra", label: "Astra", status: "seated", joinedAfterRun: 0 },
    { threadId: opus, handle: "opus", label: "Opus", status: "left", joinedAfterRun: 0 },
  ],
  discussion: null,
  closedBecause: null,
  closedAt: null,
};

describe("groupParticipants", () => {
  it("lists the primary then seated peers, leaving out seats that left", () => {
    expect(groupParticipants(group).map((p) => [p.member, p.handle])).toEqual([
      ["primary", "fable"],
      [astra, "astra"],
    ]);
    expect(isSeatedSeatThread(group, astra)).toBe(true);
    expect(isSeatedSeatThread(group, opus)).toBe(false);
  });
});

describe("groupAudienceForPrompt", () => {
  it.each([
    ["no group is active", { ...group, status: "ended" as const }, "@astra hi ", undefined],
    ["no chip", group, "what do you all think ", "everyone"],
    ["a seated peer", group, "@astra what do you think ", [astra]],
    [
      "the primary by handle, in any case",
      group,
      "@Fable and @astra weigh in ",
      ["primary", astra],
    ],
    ["a name that is not a member", group, "@README.md please ", "everyone"],
    ["a peer that left", group, "@opus hello ", "everyone"],
  ])("%s", (_name, thread, prompt, expected) => {
    expect(groupAudienceForPrompt(thread, prompt)).toEqual(expected);
  });
});

describe("isQuietPass", () => {
  it.each([
    ["PASS", true],
    ["PASS\n", true],
    ["pass", false],
    ["PASS, I agree", false],
  ])("%j", (text, expected) => {
    expect(isQuietPass(text)).toBe(expected);
  });
});

describe("groupRowSpeaker", () => {
  const primaryRun = { modelSelection: { instanceId: "i", model: "fable-5" } } as never;
  it("prefers a peer's own snapshot and names the primary from the run", () => {
    expect(groupRowSpeaker(group, { speaker: { label: "Astra", model: "gpt-6" } })).toEqual({
      label: "Astra",
      model: "gpt-6",
    });
    expect(groupRowSpeaker(group, { run: primaryRun })).toEqual({
      label: "Fable",
      model: "fable-5",
    });
  });

  it("names a switched primary by its model and leaves ordinary threads unlabeled", () => {
    const switched = { modelSelection: { instanceId: "i", model: "opus-5" } } as never;
    expect(groupRowSpeaker(group, { run: switched })?.label).toBe("opus-5");
    expect(groupRowSpeaker(null, { run: primaryRun })).toBeNull();
  });
});

describe("runningSeats", () => {
  it("counts only seated seats whose thread has an open run", () => {
    const shells = new Map([
      [astra, { id: astra, runtime: { status: "running" } }],
      [opus, { id: opus, runtime: { status: "running" } }],
    ]);
    expect(runningSeats(group, (id) => shells.get(id) as never).map((s) => s.threadId)).toEqual([
      astra,
    ]);
  });
});

describe("seatActivityLabel", () => {
  it("describes the newest unfinished item of the open run", () => {
    const items = [
      { type: "file_change", status: "completed", runId: "r1", ordinal: 1, fileName: "a.ts" },
      { type: "command_execution", status: "running", runId: "r1", ordinal: 2, input: "pnpm test" },
      { type: "reasoning", status: "running", runId: "r0", ordinal: 9 },
    ] as never as ReadonlyArray<ThreadStructureTurnItem>;
    expect(seatActivityLabel(items, RunId.make("r1"))).toBe("running pnpm test");
    expect(seatActivityLabel([], RunId.make("r1"))).toBe("working");
  });
});
