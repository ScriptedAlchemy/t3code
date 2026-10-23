import * as Schema from "effect/Schema";
import {
  CheckpointId,
  ContextTransferId,
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import {
  OrchestrationV2ContextTransferType,
  OrchestrationV2RunStatus,
  OrchestrationV2Subagent,
} from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ThreadPullRequestLinkSource } from "./threadPullRequest.ts";

export const LOOM_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const LOOM_MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Each limit applies on its own; hitting one sets only its truncation flag. */
export const LOOM_LIMITS = {
  lanes: 50,
  ancestors: 50,
  runs: 500,
  markers: 1_000,
  edges: 200,
  bytes: 256 * 1024,
} as const;

/** Run statuses grouped the way a timeline filter reads them. */
export const LoomRunStatusFilter = Schema.Literals([
  "active",
  "completed",
  "failed",
  "interrupted",
]);
export type LoomRunStatusFilter = typeof LoomRunStatusFilter.Type;

const FilterValues = <S extends Schema.Top>(value: S) =>
  Schema.Array(value).check(Schema.isMaxLength(20));

export const LoomFilters = Schema.Struct({
  /** Case-insensitive substring of the thread title. */
  title: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(200))),
  statuses: Schema.optionalKey(FilterValues(LoomRunStatusFilter)),
  providerInstanceIds: Schema.optionalKey(FilterValues(ProviderInstanceId)),
  models: Schema.optionalKey(FilterValues(TrimmedNonEmptyString)),
  branches: Schema.optionalKey(FilterValues(TrimmedNonEmptyString)),
});
export type LoomFilters = typeof LoomFilters.Type;

export const LoomWindowInput = Schema.Struct({
  projectId: ProjectId,
  /** ISO instants. Omitted bounds default to the seven days ending now. */
  from: Schema.optionalKey(IsoDateTime),
  to: Schema.optionalKey(IsoDateTime),
  filters: Schema.optionalKey(LoomFilters),
  /** From a previous page's nextCursor; only valid with the same window and filters. */
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
});
export type LoomWindowInput = typeof LoomWindowInput.Type;

export const LoomLaneRelationship = Schema.Literals(["root", "fork", "subagent"]);
export type LoomLaneRelationship = typeof LoomLaneRelationship.Type;

const LaneIdentity = {
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  relationship: LoomLaneRelationship,
  /** Null for roots. A parent outside the project or deleted is reported here but never loaded. */
  parentThreadId: Schema.NullOr(ThreadId),
};

export const LoomLane = Schema.Struct({
  ...LaneIdentity,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  branch: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type LoomLane = typeof LoomLane.Type;

/** A parent of a loaded lane that is not itself on this page; it carries no activity. */
export const LoomAncestor = Schema.Struct(LaneIdentity);
export type LoomAncestor = typeof LoomAncestor.Type;

/**
 * Queue and preparation run from requestedAt to startedAt; execution runs from startedAt to
 * completedAt (provider completion, not checkpoint finalization). A null time is unknown.
 */
export const LoomRun = Schema.Struct({
  id: RunId,
  threadId: ThreadId,
  ordinal: PositiveInt,
  status: OrchestrationV2RunStatus,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  userMessageId: MessageId,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type LoomRun = typeof LoomRun.Type;

const MarkerBase = {
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  at: IsoDateTime,
};

export const LOOM_COMMAND_PREVIEW_CHARS = 160;

export const LoomMarker = Schema.Union([
  Schema.Struct({
    ...MarkerBase,
    kind: Schema.Literal("checkpoint"),
    id: CheckpointId,
    status: Schema.Literals(["ready", "missing", "error", "stale"]),
    fileCount: NonNegativeInt,
    additions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
  /** Placed when T3 linked the PR, which may be later than its creation. */
  Schema.Struct({
    ...MarkerBase,
    kind: Schema.Literal("pull_request"),
    id: TrimmedNonEmptyString,
    repository: TrimmedNonEmptyString,
    number: PositiveInt,
    url: TrimmedNonEmptyString,
    source: ThreadPullRequestLinkSource,
    title: Schema.NullOr(Schema.String),
  }),
  /** A command that looks like a test run. Its exit code is not a pass count. */
  Schema.Struct({
    ...MarkerBase,
    kind: Schema.Literal("test_command"),
    id: TurnItemId,
    completedAt: Schema.NullOr(IsoDateTime),
    command: Schema.String.check(Schema.isMaxLength(LOOM_COMMAND_PREVIEW_CHARS)),
    exitCode: Schema.NullOr(Schema.Int),
  }),
  /** A provider-native task with no child thread to give it a lane. */
  Schema.Struct({
    ...MarkerBase,
    kind: Schema.Literal("subagent_task"),
    id: NodeId,
    completedAt: Schema.NullOr(IsoDateTime),
    status: OrchestrationV2Subagent.fields.status,
    title: Schema.NullOr(Schema.String),
  }),
]);
export type LoomMarker = typeof LoomMarker.Type;
export type LoomMarkerKind = LoomMarker["kind"];

/** A context transfer. Source and target may be the same lane, as with a provider handoff. */
export const LoomEdge = Schema.Struct({
  id: ContextTransferId,
  type: OrchestrationV2ContextTransferType,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  sourceRunId: Schema.NullOr(RunId),
  targetRunId: Schema.NullOr(RunId),
  at: IsoDateTime,
  status: Schema.String,
});
export type LoomEdge = typeof LoomEdge.Type;

export const LoomWindow = Schema.Struct({
  projectId: ProjectId,
  asOf: IsoDateTime,
  /** The bounds actually read, after defaults and clamping. Page with these, not the input. */
  from: IsoDateTime,
  to: IsoDateTime,
  lanes: Schema.Array(LoomLane),
  ancestors: Schema.Array(LoomAncestor),
  runs: Schema.Array(LoomRun),
  markers: Schema.Array(LoomMarker),
  edges: Schema.Array(LoomEdge),
  /** True where a limit dropped rows; lanes is true exactly when nextCursor is set. */
  truncated: Schema.Struct({
    lanes: Schema.Boolean,
    ancestors: Schema.Boolean,
    runs: Schema.Boolean,
    markers: Schema.Boolean,
    edges: Schema.Boolean,
    bytes: Schema.Boolean,
  }),
  coverage: Schema.Struct({
    /** Native tasks without a recorded start, which cannot be placed in time. */
    untimedTasks: NonNegativeInt,
    /** Command items examined for test recognition, and whether that scan hit its bound. */
    commandsScanned: NonNegativeInt,
    commandsTruncated: Schema.Boolean,
  }),
  nextCursor: Schema.NullOr(Schema.String),
});
export type LoomWindow = typeof LoomWindow.Type;

export class ProjectLoomError extends Schema.TaggedError<ProjectLoomError>()("ProjectLoomError", {
  reason: Schema.Literals(["storage", "missing_project", "invalid_window", "invalid_cursor"]),
  projectId: ProjectId,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    switch (this.reason) {
      case "missing_project":
        return `Project ${this.projectId} was not found.`;
      case "invalid_window":
        return "The window needs valid ISO bounds with from before to.";
      case "invalid_cursor":
        return "The cursor does not belong to this window and filters.";
      case "storage":
        return "The project timeline could not be read.";
    }
  }
}
