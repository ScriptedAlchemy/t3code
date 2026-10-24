import {
  AmbiguousRepositoryMatch,
  classifyIdentifiedRepositories,
  EnvironmentNotConnected,
  NoEligibleEnvironment,
  ProjectMissingOnTarget,
  repositoryGroupingKeyOf,
  repositoryMatchViewFromProjects,
  SourceIdentityUnresolved,
  TargetIsSourceEnvironment,
  UnknownEnvironment,
  type CrossEnvironmentTarget,
  type DisconnectedEnvironmentPhase,
  type EnvironmentId,
  type HostResourcesSnapshot,
  type ProjectId,
  type RepositoryIdentity,
  type RepositoryMatchView,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { chooseLoadBalancedEnvironment } from "../load-balancing.ts";

// A list row can say `matched` without holding this symbol, so only a fresh
// comparison in this module can build a launch target.
const matchedPeerProjectBrand = Symbol("MatchedPeerProject");
const isSourceIdentityUnresolved = Schema.is(SourceIdentityUnresolved);

export type MatchedPeerProject = ScopedProjectRef & {
  readonly [matchedPeerProjectBrand]: true;
  readonly groupingKey: string;
};

export interface ActiveProject {
  readonly id: ProjectId;
  readonly identity: RepositoryIdentity;
}

export interface ProjectIdentityShell {
  readonly id: ProjectId;
  readonly repositoryIdentity?: RepositoryIdentity | null;
}

export interface NotConnectedPeer {
  readonly environmentId: EnvironmentId;
  readonly phase: DisconnectedEnvironmentPhase;
}

export interface ConnectedPeer {
  readonly environmentId: EnvironmentId;
  readonly resources: HostResourcesSnapshot | null;
  readonly receivedAt: number;
  readonly repository: RepositoryMatchView;
  readonly projects: readonly ActiveProject[];
}

export type LaunchResolution =
  | MatchedPeerProject
  | UnknownEnvironment
  | EnvironmentNotConnected
  | TargetIsSourceEnvironment
  | ProjectMissingOnTarget
  | AmbiguousRepositoryMatch
  | NoEligibleEnvironment;

function classifyPeerProjects(source: ActiveProject, projects: readonly ActiveProject[]) {
  return classifyIdentifiedRepositories(source.identity, projects);
}

function sealMatchedPeerProject(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  groupingKey: string,
): MatchedPeerProject {
  return {
    environmentId,
    projectId,
    groupingKey,
    [matchedPeerProjectBrand]: true,
  };
}

function matchPeerProject(
  source: ActiveProject,
  targetEnvironmentId: EnvironmentId,
  targetProjects: readonly ActiveProject[],
):
  | { readonly tag: "matched"; readonly project: MatchedPeerProject }
  | { readonly tag: "missing" }
  | { readonly tag: "ambiguous"; readonly projectIds: readonly ProjectId[] } {
  const classified = classifyPeerProjects(source, targetProjects);
  switch (classified.tag) {
    case "matched":
      return {
        tag: "matched",
        project: sealMatchedPeerProject(
          targetEnvironmentId,
          classified.projectId,
          classified.groupingKey,
        ),
      };
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

function resolutionFromMatch(
  source: ActiveProject,
  environmentId: EnvironmentId,
  projects: readonly ActiveProject[],
): MatchedPeerProject | ProjectMissingOnTarget | AmbiguousRepositoryMatch {
  const match = matchPeerProject(source, environmentId, projects);
  switch (match.tag) {
    case "matched":
      return match.project;
    case "missing":
      return new ProjectMissingOnTarget({
        environmentId,
        groupingKey: repositoryGroupingKeyOf(source.identity),
      });
    case "ambiguous":
      return new AmbiguousRepositoryMatch({
        environmentId,
        projectIds: match.projectIds,
      });
    default: {
      const unexpected: never = match;
      return unexpected;
    }
  }
}

export function parseSourceProject(
  project: ProjectIdentityShell,
): ActiveProject | SourceIdentityUnresolved {
  if (project.repositoryIdentity == null) {
    return new SourceIdentityUnresolved({ projectId: project.id });
  }
  return { id: project.id, identity: project.repositoryIdentity };
}

export function activeProjectsFromShells(
  projects: readonly ProjectIdentityShell[],
): readonly ActiveProject[] {
  const active: ActiveProject[] = [];
  for (const project of projects) {
    const parsed = parseSourceProject(project);
    if (isSourceIdentityUnresolved(parsed)) {
      continue;
    }
    active.push(parsed);
  }
  return active;
}

export function repositoryMatchView(
  source: ActiveProject | SourceIdentityUnresolved,
  projects: readonly ActiveProject[],
): RepositoryMatchView {
  if (isSourceIdentityUnresolved(source)) {
    return repositoryMatchViewFromProjects(null, []);
  }
  return repositoryMatchViewFromProjects(source.identity, projects);
}

function ambiguousAmong(
  source: ActiveProject,
  rows: readonly ConnectedPeer[],
): AmbiguousRepositoryMatch | undefined {
  for (const row of rows) {
    const classified = classifyPeerProjects(source, row.projects);
    if (classified.tag === "ambiguous") {
      return new AmbiguousRepositoryMatch({
        environmentId: row.environmentId,
        projectIds: classified.projectIds,
      });
    }
  }
  return undefined;
}

export function resolveLaunchTarget(input: {
  readonly callerEnvironmentId: EnvironmentId;
  readonly source: ActiveProject;
  readonly target: CrossEnvironmentTarget;
  readonly connected: readonly ConnectedPeer[];
  readonly notConnected: readonly NotConnectedPeer[];
  readonly weights: Readonly<Record<string, number>>;
  readonly now: number;
}): LaunchResolution {
  switch (input.target.kind) {
    case "environment": {
      const targetId = input.target.environmentId;
      if (targetId === input.callerEnvironmentId) {
        return new TargetIsSourceEnvironment({ environmentId: targetId });
      }
      const connected = input.connected.find((row) => row.environmentId === targetId);
      if (connected !== undefined) {
        return resolutionFromMatch(input.source, connected.environmentId, connected.projects);
      }
      const disconnected = input.notConnected.find((row) => row.environmentId === targetId);
      if (disconnected !== undefined) {
        return new EnvironmentNotConnected({
          environmentId: disconnected.environmentId,
          phase: disconnected.phase,
        });
      }
      return new UnknownEnvironment({ environmentId: targetId });
    }
    case "load_balanced": {
      const foreign = input.connected.filter(
        (row) => row.environmentId !== input.callerEnvironmentId,
      );
      const candidates = foreign.filter((row) => row.repository.tag === "matched");
      if (candidates.length === 0) {
        return ambiguousAmong(input.source, foreign) ?? new NoEligibleEnvironment();
      }
      const chosenId = chooseLoadBalancedEnvironment(
        candidates.map((row) => ({
          environmentId: row.environmentId,
          resources: row.resources,
          receivedAt: row.receivedAt,
          weight: input.weights[row.environmentId] ?? 50,
        })),
        input.now,
      );
      if (chosenId === null) {
        return new NoEligibleEnvironment();
      }
      const chosen = candidates.find((row) => row.environmentId === chosenId);
      if (chosen === undefined) {
        return new NoEligibleEnvironment();
      }
      // The tag only decided who was scored. The brand comes from this match.
      return resolutionFromMatch(input.source, chosen.environmentId, chosen.projects);
    }
    default: {
      const unexpected: never = input.target;
      return unexpected;
    }
  }
}
