import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";

/**
 * Presentation phases other than `connected`. Kept in sync with
 * `EnvironmentConnectionPhase` by a check in the client matcher.
 */
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
    return "No client is connected to report peer environments.";
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
]);
export type CrossEnvironmentFailure = typeof CrossEnvironmentFailure.Type;
