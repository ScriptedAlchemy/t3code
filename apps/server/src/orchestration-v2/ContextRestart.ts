import type { OrchestrationV2ContextRestart } from "@t3tools/contracts";

/**
 * When a turn starts a fresh native conversation seeded from summaries instead of re-reading a
 * large one. Turn start owns the effects; this owns the rule.
 */

export interface ContextRestartUsage {
  /** Latest measured context of the current native conversation. */
  readonly usedTokens: number;
  /** Its first measured context, the best estimate of what a fresh conversation costs. */
  readonly firstUsedTokens: number;
}

type ContextRestartNotDue =
  | "off"
  | "summaries_off"
  | "not_codex"
  | "unmeasured"
  | "below_mark"
  | "would_not_halve";

/** The restart a thread is large enough for, or why it is not. */
export function contextRestartDue(input: {
  readonly aboveTokens: number | null;
  readonly summariesEnabled: boolean;
  readonly driver: string;
  readonly usage: ContextRestartUsage | undefined;
}): OrchestrationV2ContextRestart | ContextRestartNotDue {
  if (input.aboveTokens === null) return "off";
  if (!input.summariesEnabled) return "summaries_off";
  if (input.driver !== "codex") return "not_codex";
  if (input.usage === undefined) return "unmeasured";
  if (input.usage.usedTokens < input.aboveTokens) return "below_mark";
  // A restart must at least halve the context, so the next one waits for as much growth as
  // this one removed and the prompt cache is rebuilt rarely.
  if (input.usage.firstUsedTokens * 2 > input.usage.usedTokens) return "would_not_halve";
  return { usedTokens: input.usage.usedTokens, aboveTokens: input.aboveTokens };
}

export type ContextRestartRefusal =
  | "control_message"
  | "restart_continuation"
  | "group_discussion"
  | "summary_pass_pending"
  | "background_work"
  | "history_gap";

/** What keeps a due restart from happening this turn, or null when nothing does. */
export function contextRestartRefusal(input: {
  readonly controlMessage: boolean;
  readonly restartContinuation: boolean;
  readonly groupDiscussion: boolean;
  readonly summaryPassPending: boolean;
  readonly pendingBackgroundWork: boolean;
  /** Older items that would reach the fresh conversation neither verbatim nor summarized. */
  readonly uncoveredItems: number;
}): ContextRestartRefusal | null {
  if (input.controlMessage) return "control_message";
  if (input.restartContinuation) return "restart_continuation";
  if (input.groupDiscussion) return "group_discussion";
  if (input.summaryPassPending) return "summary_pass_pending";
  if (input.pendingBackgroundWork) return "background_work";
  if (input.uncoveredItems > 0) return "history_gap";
  return null;
}
