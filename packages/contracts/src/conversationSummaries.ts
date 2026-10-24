import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  KnowledgeMessageRef,
  KnowledgeSourceUnavailableReason,
  ProjectKnowledgeSource,
} from "./projectKnowledge.ts";

/** Derived from the thread and the exact source identities, so one range has one summary. */
export const ConversationSummaryId = Schema.String.check(
  Schema.isPattern(/^summary:[a-f0-9]{64}$/),
);
export type ConversationSummaryId = typeof ConversationSummaryId.Type;

export const CONVERSATION_SUMMARY_MAX_SOURCES = 24;

export const ConversationSummaryStatement = Schema.Struct({
  text: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(600)),
  /** Message ids from the summary's own sources. */
  citations: Schema.Array(MessageId).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export type ConversationSummaryStatement = typeof ConversationSummaryStatement.Type;

/**
 * An immutable leaf summary of consecutive finalized messages. Its text is only served while
 * every source still matches its digest.
 */
export const ConversationSummary = Schema.Struct({
  id: ConversationSummaryId,
  projectId: ProjectId,
  threadId: ThreadId,
  sources: Schema.Array(KnowledgeMessageRef).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CONVERSATION_SUMMARY_MAX_SOURCES),
  ),
  statements: Schema.Array(ConversationSummaryStatement).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
  modelSelection: ModelSelection,
  createdAt: IsoDateTime,
});
export type ConversationSummary = typeof ConversationSummary.Type;

export const ConversationSummaryRead = Schema.Union([
  Schema.Struct({ state: Schema.Literal("available"), summary: ConversationSummary }),
  // A source changed or went away: the generated text is withheld.
  Schema.Struct({
    state: Schema.Literal("stale"),
    id: ConversationSummaryId,
    sourceCount: NonNegativeInt,
    createdAt: IsoDateTime,
    reason: KnowledgeSourceUnavailableReason,
  }),
]);
export type ConversationSummaryRead = typeof ConversationSummaryRead.Type;

/** What the latest background pass for a thread did. */
export const ConversationSummaryPass = Schema.Struct({
  runId: RunId,
  result: Schema.Literals(["ran", "skipped", "failed"]),
  reason: Schema.NullOr(Schema.String),
  generated: NonNegativeInt,
  /** Settled messages still waiting for a summary after this pass. */
  waitingMessages: NonNegativeInt,
  at: IsoDateTime,
});
export type ConversationSummaryPass = typeof ConversationSummaryPass.Type;

const Scope = { projectId: ProjectId, threadId: ThreadId };

export const ConversationSummaryListInput = Schema.Struct({
  ...Scope,
  cursor: Schema.optionalKey(ConversationSummaryId),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});
export type ConversationSummaryListInput = typeof ConversationSummaryListInput.Type;

export const ConversationSummaryList = Schema.Struct({
  enabled: Schema.Boolean,
  lastPass: Schema.NullOr(ConversationSummaryPass),
  summaries: Schema.Array(ConversationSummaryRead),
  nextCursor: Schema.NullOr(ConversationSummaryId),
});
export type ConversationSummaryList = typeof ConversationSummaryList.Type;

export const ConversationSummaryDescribeInput = Schema.Struct({
  ...Scope,
  summaryId: ConversationSummaryId,
});
export type ConversationSummaryDescribeInput = typeof ConversationSummaryDescribeInput.Type;

export const ConversationSummaryExpandInput = Schema.Struct({
  ...ConversationSummaryDescribeInput.fields,
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CONVERSATION_SUMMARY_MAX_SOURCES })),
  ),
});
export type ConversationSummaryExpandInput = typeof ConversationSummaryExpandInput.Type;

export const ConversationSummaryExpansion = Schema.Struct({
  summary: ConversationSummaryRead,
  /** The canonical message as it is now, or why it is unavailable; never stored text. */
  sources: Schema.Array(
    Schema.Struct({ ref: KnowledgeMessageRef, result: ProjectKnowledgeSource }),
  ),
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type ConversationSummaryExpansion = typeof ConversationSummaryExpansion.Type;

export class ConversationSummaryError extends Schema.TaggedError<ConversationSummaryError>()(
  "ConversationSummaryError",
  {
    reason: Schema.Literals(["storage", "missing_project", "missing_summary", "invalid_cursor"]),
    projectId: ProjectId,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "missing_project":
        return `Project ${this.projectId} was not found.`;
      case "missing_summary":
        return "No conversation summary with that id exists for this project and thread.";
      case "invalid_cursor":
        return "The cursor or offset does not belong to this listing.";
      case "storage":
        return "Conversation summaries could not be read.";
    }
  }
}
