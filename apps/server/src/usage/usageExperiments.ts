import type { ServerSettings } from "@t3tools/contracts";

export type BooleanSettingKey = {
  [K in keyof ServerSettings]-?: ServerSettings[K] extends boolean ? K : never;
}[keyof ServerSettings];

export interface UsageExperimentDefinition {
  readonly label: string;
  /** The flag makes model calls that no provider transcript records, so transcript cost understates it. */
  readonly spendsOutsideTranscripts?: true;
}

/**
 * Flags the cost report compares. A flag's consumer must read the settings the stamp resolves,
 * not a project file, or the stamp would not match what ran.
 */
export const USAGE_EXPERIMENTS = {
  enableAssistedLearning: { label: "Assisted learning", spendsOutsideTranscripts: true },
  enableConversationSummaries: { label: "Conversation summaries", spendsOutsideTranscripts: true },
  enableModelEvaluations: { label: "Model evaluations", spendsOutsideTranscripts: true },
  pstackEnabled: { label: "Pstack" },
  enableAgentGitHubReadGate: { label: "Agent GitHub read gate" },
  threadSplitSuggestionsEnabled: { label: "Thread split suggestions" },
} as const satisfies Partial<Record<BooleanSettingKey, UsageExperimentDefinition>>;
