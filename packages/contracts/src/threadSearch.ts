import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

const SearchQuery = TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200));

export const ThreadSearchCursor = Schema.Struct({
  query: SearchQuery,
  projectId: Schema.NullOr(ProjectId),
  includeArchived: Schema.Boolean,
  rank: Schema.Literals([0, 1]),
  updatedAt: IsoDateTime,
  threadId: ThreadId,
});

export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: SearchQuery,
  cursor: Schema.optionalKey(ThreadSearchCursor),
  projectId: Schema.optionalKey(ProjectId),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  messageId: Schema.optionalKey(MessageId),
  digest: Schema.optionalKey(Schema.String),
  archived: Schema.optionalKey(Schema.Boolean),
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
  nextCursor: Schema.optionalKey(Schema.NullOr(ThreadSearchCursor)),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export class OrchestrationSearchThreadsError extends Schema.TaggedError<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
