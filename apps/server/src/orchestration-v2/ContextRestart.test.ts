import { assert, describe, it } from "@effect/vitest";

import { contextRestartDue, contextRestartRefusal } from "./ContextRestart.ts";

const due = {
  aboveTokens: 200_000,
  summariesEnabled: true,
  driver: "codex",
  usage: { usedTokens: 200_000, firstUsedTokens: 100_000 },
} as const;

const unrefused = {
  controlMessage: false,
  restartContinuation: false,
  groupDiscussion: false,
  summaryPassPending: false,
  pendingBackgroundWork: false,
  uncoveredItems: 0,
} as const;

describe("context restart rule", () => {
  it.each([
    ["due at the mark", due, { usedTokens: 200_000, aboveTokens: 200_000 }],
    ["setting empty", { ...due, aboveTokens: null }, "off"],
    ["summaries off", { ...due, summariesEnabled: false }, "summaries_off"],
    ["Claude", { ...due, driver: "claudeAgent" }, "not_codex"],
    ["no measured usage", { ...due, usage: undefined }, "unmeasured"],
    [
      "one token below the mark",
      { ...due, usage: { ...due.usage, usedTokens: 199_999, firstUsedTokens: 90_000 } },
      "below_mark",
    ],
    [
      "fresh estimate one token over half",
      { ...due, usage: { ...due.usage, firstUsedTokens: 100_001 } },
      "would_not_halve",
    ],
    [
      "the turn right after a restart",
      { ...due, usage: { usedTokens: 250_000, firstUsedTokens: 250_000 } },
      "would_not_halve",
    ],
  ] as const)("%s", (_name, input, expected) => {
    assert.deepEqual(contextRestartDue(input), expected);
  });

  it.each([
    ["nothing refuses", unrefused, null],
    ["a control message", { ...unrefused, controlMessage: true }, "control_message"],
    ["a restart continuation", { ...unrefused, restartContinuation: true }, "restart_continuation"],
    ["a group discussion", { ...unrefused, groupDiscussion: true }, "group_discussion"],
    [
      "a summary pass with work left",
      { ...unrefused, summaryPassPending: true },
      "summary_pass_pending",
    ],
    ["pending background work", { ...unrefused, pendingBackgroundWork: true }, "background_work"],
    ["one older item without cover", { ...unrefused, uncoveredItems: 1 }, "history_gap"],
  ] as const)("%s", (_name, input, expected) => {
    assert.equal(contextRestartRefusal(input), expected);
  });
});
