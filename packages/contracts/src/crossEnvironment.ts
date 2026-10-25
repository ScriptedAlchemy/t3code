import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RepositoryIdentity, repositoryGroupingKeyOf } from "./environment.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";

export const DisconnectedEnvironmentPhase = Schema.Literals([
  "available",
  "offline",
  "connecting",
  "reconnecting",
  "error",
  "unsupported",
]);
export type DisconnectedEnvironmentPhase = typeof DisconnectedEnvironmentPhase.Type;

export const RepositoryMatchView = Schema.Union([
  Schema.Struct({
    tag: Schema.Literal("matched"),
    projectId: ProjectId,
  }),
  Schema.Struct({
    tag: Schema.Literal("missing"),
  }),
  Schema.Struct({
    tag: Schema.Literal("ambiguous"),
    projectIds: Schema.Array(ProjectId),
  }),
  Schema.Struct({
    tag: Schema.Literal("unresolved"),
  }),
]);
export type RepositoryMatchView = typeof RepositoryMatchView.Type;

export const ConnectedEnvironmentView = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  isCaller: Schema.Boolean,
  resources: Schema.NullOr(HostResourcesSnapshot),
  receivedAt: NonNegativeInt,
  repository: RepositoryMatchView,
});
export type ConnectedEnvironmentView = typeof ConnectedEnvironmentView.Type;

export const CrossEnvironmentTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("environment"),
    environmentId: EnvironmentId,
  }),
  Schema.Struct({
    kind: Schema.Literal("load_balanced"),
  }),
]);
export type CrossEnvironmentTarget = typeof CrossEnvironmentTarget.Type;

export class UnknownEnvironment extends Schema.TaggedError<UnknownEnvironment>()(
  "UnknownEnvironment",
  {
    environmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} is not in the peer catalog.`;
  }
}

export class EnvironmentNotConnected extends Schema.TaggedError<EnvironmentNotConnected>()(
  "EnvironmentNotConnected",
  {
    environmentId: EnvironmentId,
    phase: DisconnectedEnvironmentPhase,
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} is ${this.phase}.`;
  }
}

export class TargetIsSourceEnvironment extends Schema.TaggedError<TargetIsSourceEnvironment>()(
  "TargetIsSourceEnvironment",
  {
    environmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} is the caller.`;
  }
}

export class SourceIdentityUnresolved extends Schema.TaggedError<SourceIdentityUnresolved>()(
  "SourceIdentityUnresolved",
  {
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project ${this.projectId} has no repository identity.`;
  }
}

export class ProjectMissingOnTarget extends Schema.TaggedError<ProjectMissingOnTarget>()(
  "ProjectMissingOnTarget",
  {
    environmentId: EnvironmentId,
    groupingKey: Schema.String,
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} has no project for ${this.groupingKey}.`;
  }
}

export class AmbiguousRepositoryMatch extends Schema.TaggedError<AmbiguousRepositoryMatch>()(
  "AmbiguousRepositoryMatch",
  {
    environmentId: EnvironmentId,
    projectIds: Schema.Array(ProjectId),
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} has more than one project for this repository.`;
  }
}

export class NoEligibleEnvironment extends Schema.TaggedError<NoEligibleEnvironment>()(
  "NoEligibleEnvironment",
  {},
) {
  override get message(): string {
    return "No peer environment can host this repository.";
  }
}

export class PeerCatalogUnavailable extends Schema.TaggedError<PeerCatalogUnavailable>()(
  "PeerCatalogUnavailable",
  {},
) {
  override get message(): string {
    return "No connected client could report peer environments.";
  }
}

export class TargetModelUnavailable extends Schema.TaggedError<TargetModelUnavailable>()(
  "TargetModelUnavailable",
  {
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project ${this.projectId} has no default model.`;
  }
}

export class CrossEnvironmentLaunchRejected extends Schema.TaggedError<CrossEnvironmentLaunchRejected>()(
  "CrossEnvironmentLaunchRejected",
  {},
) {
  override get message(): string {
    return "The destination environment rejected the launch.";
  }
}

export class CrossEnvironmentLaunchUncertain extends Schema.TaggedError<CrossEnvironmentLaunchUncertain>()(
  "CrossEnvironmentLaunchUncertain",
  {
    threadId: ThreadId,
    environmentId: Schema.NullOr(EnvironmentId),
  },
) {
  override get message(): string {
    return `The launch of thread ${this.threadId} was not confirmed. It may already have started; locate it on the destination before retrying and pin any retry to that environment.`;
  }
}

export const CrossEnvironmentFailure = Schema.Union([
  UnknownEnvironment,
  EnvironmentNotConnected,
  TargetIsSourceEnvironment,
  SourceIdentityUnresolved,
  ProjectMissingOnTarget,
  AmbiguousRepositoryMatch,
  NoEligibleEnvironment,
  PeerCatalogUnavailable,
  TargetModelUnavailable,
  CrossEnvironmentLaunchRejected,
  CrossEnvironmentLaunchUncertain,
]);
export type CrossEnvironmentFailure = typeof CrossEnvironmentFailure.Type;

export const ConnectedEnvironmentsResult = Schema.Struct({
  callerEnvironmentId: EnvironmentId,
  environments: Schema.Array(ConnectedEnvironmentView),
});
export type ConnectedEnvironmentsResult = typeof ConnectedEnvironmentsResult.Type;

export const CrossEnvironmentLaunchKind = Schema.Literals(["run", "thread"]);
export type CrossEnvironmentLaunchKind = typeof CrossEnvironmentLaunchKind.Type;

export const CrossEnvironmentLaunchResult = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: Schema.NullOr(OrchestrationV2RunStatus),
  kind: CrossEnvironmentLaunchKind,
});
export type CrossEnvironmentLaunchResult = typeof CrossEnvironmentLaunchResult.Type;

const CrossEnvironmentLaunchFields = {
  target: CrossEnvironmentTarget,
  title: TrimmedNonEmptyString,
  clientRequestId: TrimmedNonEmptyString,
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
};

export const CrossEnvironmentLaunchRequest = Schema.Union([
  Schema.Struct({
    ...CrossEnvironmentLaunchFields,
    kind: Schema.Literal("run"),
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...CrossEnvironmentLaunchFields,
    kind: Schema.Literal("thread"),
    message: Schema.optional(Schema.String),
  }),
]);
export type CrossEnvironmentLaunchRequest = typeof CrossEnvironmentLaunchRequest.Type;

export const CrossEnvironmentListAsk = Schema.Struct({
  requestId: Schema.String,
  op: Schema.Literal("list"),
  callerEnvironmentId: EnvironmentId,
  sourceProjectId: Schema.optional(ProjectId),
});
export type CrossEnvironmentListAsk = typeof CrossEnvironmentListAsk.Type;

const CrossEnvironmentLaunchAskFields = {
  requestId: Schema.String,
  callerEnvironmentId: EnvironmentId,
  sourceProjectId: ProjectId,
  commandId: CommandId,
  threadId: ThreadId,
  target: CrossEnvironmentTarget,
  title: TrimmedNonEmptyString,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
};

export const CrossEnvironmentLaunchAsk = Schema.Union([
  Schema.Struct({
    ...CrossEnvironmentLaunchAskFields,
    op: Schema.Literal("launch"),
    kind: Schema.Literal("run"),
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...CrossEnvironmentLaunchAskFields,
    op: Schema.Literal("launch"),
    kind: Schema.Literal("thread"),
    message: Schema.optional(Schema.String),
  }),
]);
export type CrossEnvironmentLaunchAsk = typeof CrossEnvironmentLaunchAsk.Type;

export const CrossEnvironmentAsk = Schema.Union([
  CrossEnvironmentListAsk,
  CrossEnvironmentLaunchAsk,
]);
export type CrossEnvironmentAsk = typeof CrossEnvironmentAsk.Type;

export const CrossEnvironmentClaim = Schema.Struct({
  requestId: Schema.String,
  environmentId: EnvironmentId,
});
export type CrossEnvironmentClaim = typeof CrossEnvironmentClaim.Type;

export const CrossEnvironmentFulfillment = Schema.Union([
  Schema.Struct({
    requestId: Schema.String,
    op: Schema.Literal("list"),
    result: ConnectedEnvironmentsResult,
  }),
  Schema.Struct({
    requestId: Schema.String,
    op: Schema.Literal("launch"),
    result: CrossEnvironmentLaunchResult,
  }),
  Schema.Struct({
    requestId: Schema.String,
    error: CrossEnvironmentFailure,
  }),
]);
export type CrossEnvironmentFulfillment = typeof CrossEnvironmentFulfillment.Type;

export interface RepositoryProjectRef {
  readonly id: ProjectId;
  readonly identity: RepositoryIdentity;
}

export type IdentifiedRepositoryMatch =
  | { readonly tag: "matched"; readonly projectId: ProjectId; readonly groupingKey: string }
  | { readonly tag: "missing"; readonly groupingKey: string }
  | {
      readonly tag: "ambiguous";
      readonly groupingKey: string;
      readonly projectIds: readonly ProjectId[];
    };

export function classifyIdentifiedRepositories(
  source: RepositoryIdentity,
  projects: readonly RepositoryProjectRef[],
): IdentifiedRepositoryMatch {
  const groupingKey = repositoryGroupingKeyOf(source);
  const hits = projects.filter(
    (project) => repositoryGroupingKeyOf(project.identity) === groupingKey,
  );
  const first = hits[0];
  if (first === undefined) {
    return { tag: "missing", groupingKey };
  }
  if (hits.length > 1) {
    return { tag: "ambiguous", groupingKey, projectIds: hits.map((project) => project.id) };
  }
  return { tag: "matched", projectId: first.id, groupingKey };
}

export function repositoryMatchViewFromProjects(
  source: RepositoryIdentity | null | undefined,
  projects: readonly RepositoryProjectRef[],
): RepositoryMatchView {
  if (source == null) {
    return { tag: "unresolved" };
  }
  const classified = classifyIdentifiedRepositories(source, projects);
  switch (classified.tag) {
    case "matched":
      return { tag: "matched", projectId: classified.projectId };
    case "missing":
      return { tag: "missing" };
    case "ambiguous":
      return { tag: "ambiguous", projectIds: classified.projectIds };
    default: {
      const unexpected: never = classified;
      return unexpected;
    }
  }
}
