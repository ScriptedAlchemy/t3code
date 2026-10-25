import { WS_METHODS, type ConversationSummaryPass } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "../state/runtime.ts";

export function createConversationSummariesAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "conversation-summaries:list",
      tag: WS_METHODS.conversationSummariesList,
      staleTimeMs: 0,
    }),
    expand: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "conversation-summaries:expand",
      tag: WS_METHODS.conversationSummariesExpand,
      staleTimeMs: 0,
    }),
  };
}

export function conversationSummaryPassLabel(pass: ConversationSummaryPass): string {
  const waiting =
    pass.waitingMessages === 0
      ? ""
      : ` ${pass.waitingMessages} older ${pass.waitingMessages === 1 ? "message waits" : "messages wait"} for a summary.`;
  switch (pass.result) {
    case "ran":
      return `Last pass wrote ${pass.generated} ${pass.generated === 1 ? "summary" : "summaries"}.${waiting}`;
    case "skipped":
      return `Last pass wrote nothing. ${pass.reason ?? ""}${waiting}`.trim();
    case "failed":
      return `Last pass failed. ${pass.reason ?? ""}${waiting}`.trim();
  }
}
