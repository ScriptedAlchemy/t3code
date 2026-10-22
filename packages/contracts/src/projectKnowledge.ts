import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
} from "./threadSearch.ts";

export const ProjectFactId = TrimmedNonEmptyString.pipe(Schema.brand("ProjectFactId"));
export type ProjectFactId = typeof ProjectFactId.Type;
export const KnowledgeDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const KnowledgeMessageRef = Schema.Struct({
  kind: Schema.Literal("message"),
  threadId: ThreadId,
  messageId: MessageId,
  digest: KnowledgeDigest,
});
export type KnowledgeMessageRef = typeof KnowledgeMessageRef.Type;
export const KnowledgeFactSource = Schema.Union([
  KnowledgeMessageRef,
  Schema.Struct({ kind: Schema.Literal("user") }),
]);
export type KnowledgeFactSource = typeof KnowledgeFactSource.Type;
export const KnowledgeSelection = Schema.Union([
  KnowledgeMessageRef,
  Schema.Struct({ kind: Schema.Literal("fact"), factId: ProjectFactId, revision: PositiveInt }),
]);
export type KnowledgeSelection = typeof KnowledgeSelection.Type;
export const ProjectFactKind = Schema.Literals(["decision", "constraint", "convention", "note"]);
const Labels = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).check(
  Schema.isMaxLength(32),
);
export const ProjectFactFields = Schema.Struct({
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(12000)),
  entities: Labels,
  tags: Labels,
  kind: ProjectFactKind,
  sources: Schema.Array(KnowledgeFactSource).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
});
const FactIdentity = {
  id: ProjectFactId,
  projectId: ProjectId,
  kind: ProjectFactKind,
  revision: PositiveInt,
  trust: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  retrievalCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};
export const ActiveProjectFact = Schema.Struct({
  ...FactIdentity,
  ...ProjectFactFields.fields,
  status: Schema.Literals(["proposed", "confirmed"]),
  forgottenAt: Schema.Null,
});
const ProjectFactSchema = Schema.Union([
  ActiveProjectFact,
  Schema.Struct({
    ...FactIdentity,
    status: Schema.Literal("forgotten"),
    content: Schema.Null,
    entities: Schema.Array(Schema.Never),
    tags: Schema.Array(Schema.Never),
    sources: Schema.Array(Schema.Never),
    forgottenAt: IsoDateTime,
  }),
]);
export type ProjectFact = typeof ProjectFactSchema.Type;
export const ProjectFact: Schema.Codec<ProjectFact, typeof ProjectFactSchema.Encoded> =
  ProjectFactSchema;
const MutationIdentity = { commandId: CommandId, projectId: ProjectId, factId: ProjectFactId };
const ExistingFact = { ...MutationIdentity, expectedRevision: PositiveInt };
const ProjectKnowledgeMutationSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create"),
    ...MutationIdentity,
    ...ProjectFactFields.fields,
  }),
  Schema.Struct({ action: Schema.Literal("edit"), ...ExistingFact, ...ProjectFactFields.fields }),
  Schema.Struct({ action: Schema.Literal("confirm"), ...ExistingFact }),
  Schema.Struct({ action: Schema.Literal("forget"), ...ExistingFact }),
  Schema.Struct({ action: Schema.Literal("feedback"), ...ExistingFact, helpful: Schema.Boolean }),
]);
export type ProjectKnowledgeMutation = typeof ProjectKnowledgeMutationSchema.Type;
export const ProjectKnowledgeMutation: Schema.Codec<
  ProjectKnowledgeMutation,
  typeof ProjectKnowledgeMutationSchema.Encoded
> = ProjectKnowledgeMutationSchema;
export const ProjectKnowledgeListInput = Schema.Struct({
  projectId: ProjectId,
  status: Schema.optionalKey(Schema.Literals(["confirmed", "proposed", "forgotten"])),
  afterId: Schema.optionalKey(ProjectFactId),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type ProjectKnowledgeListInput = typeof ProjectKnowledgeListInput.Type;
const ProjectKnowledgeListResultSchema = Schema.Struct({
  facts: Schema.Array(ProjectFact),
  nextCursor: Schema.NullOr(ProjectFactId),
});
export type ProjectKnowledgeListResult = typeof ProjectKnowledgeListResultSchema.Type;
export const ProjectKnowledgeListResult: Schema.Codec<
  ProjectKnowledgeListResult,
  typeof ProjectKnowledgeListResultSchema.Encoded
> = ProjectKnowledgeListResultSchema;
export const ProjectKnowledgeReadSourceInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  messageId: MessageId,
  digest: Schema.optionalKey(KnowledgeDigest),
  includeArchived: Schema.optionalKey(Schema.Boolean),
});
export type ProjectKnowledgeReadSourceInput = typeof ProjectKnowledgeReadSourceInput.Type;
const ProjectKnowledgeSourceSchema = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("available"),
    source: KnowledgeMessageRef,
    text: Schema.String,
    title: Schema.String,
    role: Schema.Literals(["user", "assistant"]),
    createdAt: IsoDateTime,
    archived: Schema.Boolean,
  }),
  Schema.Struct({
    state: Schema.Literal("unavailable"),
    reason: Schema.Literals([
      "missing",
      "deleted",
      "archived",
      "wrong_project",
      "streaming",
      "changed",
    ]),
  }),
]);
export type ProjectKnowledgeSource = typeof ProjectKnowledgeSourceSchema.Type;
export const ProjectKnowledgeSource: Schema.Codec<
  ProjectKnowledgeSource,
  typeof ProjectKnowledgeSourceSchema.Encoded
> = ProjectKnowledgeSourceSchema;
const ProjectKnowledgeContextSchema = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  selections: Schema.Array(KnowledgeSelection).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 48000 })),
});
export type ProjectKnowledgeContext = typeof ProjectKnowledgeContextSchema.Type;
export const ProjectKnowledgeContext: Schema.Codec<
  ProjectKnowledgeContext,
  typeof ProjectKnowledgeContextSchema.Encoded
> = ProjectKnowledgeContextSchema;
const ProjectKnowledgePreparedContextSchema = Schema.Struct({
  context: ProjectKnowledgeContext,
  text: Schema.String,
  byteLength: NonNegativeInt,
});
export type ProjectKnowledgePreparedContext = typeof ProjectKnowledgePreparedContextSchema.Type;
export const ProjectKnowledgePreparedContext: Schema.Codec<
  ProjectKnowledgePreparedContext,
  typeof ProjectKnowledgePreparedContextSchema.Encoded
> = ProjectKnowledgePreparedContextSchema;
export const ProjectKnowledgeSearchInput = Schema.Struct({
  ...OrchestrationSearchThreadsInput.fields,
  projectId: ProjectId,
  requestId: CommandId,
  entities: Schema.optionalKey(Labels),
  entityMatch: Schema.optionalKey(Schema.Literals(["any", "all"])),
});
export type ProjectKnowledgeSearchInput = typeof ProjectKnowledgeSearchInput.Type;
export const KnowledgeScore = Schema.Struct({
  holographic: Schema.Number,
  lexical: Schema.Number,
  tokenOverlap: Schema.Number,
  temporalDecay: Schema.Number,
  reinforcement: Schema.Number,
  trust: Schema.Number,
  combined: Schema.Number,
});
const ProjectKnowledgeSearchResultSchema = Schema.Struct({
  messages: OrchestrationSearchThreadsResult,
  facts: Schema.Union([
    Schema.Struct({
      state: Schema.Literal("available"),
      matches: Schema.Array(Schema.Struct({ fact: ProjectFact, score: KnowledgeScore })),
      coverage: Schema.Literals(["complete", "partial"]),
    }),
    Schema.Struct({
      state: Schema.Literal("unavailable"),
      reason: Schema.Literal("kernel_unavailable"),
    }),
  ]),
});
export type ProjectKnowledgeSearchResult = typeof ProjectKnowledgeSearchResultSchema.Type;
export const ProjectKnowledgeSearchResult: Schema.Codec<
  ProjectKnowledgeSearchResult,
  typeof ProjectKnowledgeSearchResultSchema.Encoded
> = ProjectKnowledgeSearchResultSchema;
export class ProjectKnowledgeError extends Schema.TaggedError<ProjectKnowledgeError>()(
  "ProjectKnowledgeError",
  {
    reason: Schema.Literals([
      "missing_project",
      "missing_fact",
      "conflict",
      "forgotten",
      "invalid_source",
      "user_confirmation_required",
      "wrong_environment",
      "wrong_project",
      "stale_context",
      "context_budget",
      "command_reused",
      "storage",
    ]),
    projectId: ProjectId,
    factId: Schema.optionalKey(ProjectFactId),
    currentRevision: Schema.optionalKey(PositiveInt),
    byteLength: Schema.optionalKey(NonNegativeInt),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "conflict":
        return "This fact changed. Refresh it before editing.";
      case "forgotten":
        return "This fact was forgotten and cannot be restored.";
      case "invalid_source":
        return "The selected source is unavailable or has changed.";
      case "user_confirmation_required":
        return "A user must confirm proposed knowledge.";
      case "wrong_project":
        return "This context belongs to another project.";
      case "wrong_environment":
        return "This context belongs to another environment.";
      case "stale_context":
        return "Selected knowledge changed. Refresh or remove it before sending.";
      case "context_budget":
        return "Selected knowledge exceeds the context allowance. Remove an item before sending.";
      case "command_reused":
        return "This request ID already belongs to another operation.";
      case "missing_fact":
        return "The project fact was not found.";
      case "missing_project":
        return "The project was not found.";
      case "storage":
        return "Project knowledge storage is unavailable.";
    }
  }
}
