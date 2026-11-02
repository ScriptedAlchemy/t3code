import type {
  OrchestrationProjectShell,
  PullRequestReadTarget,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-definitions/registry";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { normalizeThreadPullRequestKey } from "../sourceControl/threadPullRequests.ts";
import { pullRequestSyncKey } from "./pullRequestSyncKey.ts";

export class PullRequestUrlInvalidError extends Schema.TaggedError<PullRequestUrlInvalidError>()(
  "PullRequestUrlInvalidError",
  {},
) {
  override get message(): string {
    return "This is not a recognised pull request URL. Pass repository and number instead.";
  }
}

export class PullRequestTargetIncompleteError extends Schema.TaggedError<PullRequestTargetIncompleteError>()(
  "PullRequestTargetIncompleteError",
  {},
) {
  override get message(): string {
    return "Pass either url, or both repository and number.";
  }
}

export class PullRequestHostRequiredError extends Schema.TaggedError<PullRequestHostRequiredError>()(
  "PullRequestHostRequiredError",
  {},
) {
  override get message(): string {
    return "This thread's project has no recognised remote. Pass host or url.";
  }
}

export class PullRequestUrlUnavailableError extends Schema.TaggedError<PullRequestUrlUnavailableError>()(
  "PullRequestUrlUnavailableError",
  {},
) {
  override get message(): string {
    return "This thread's project is on a host with no known pull request URL shape. Pass url.";
  }
}

export class PullRequestProjectNotFoundError extends Schema.TaggedError<PullRequestProjectNotFoundError>()(
  "PullRequestProjectNotFoundError",
  { repository: Schema.String },
) {
  override get message(): string {
    return `No project in this environment is a checkout of ${this.repository}, so its pull requests cannot be read here. Add one with t3_project_create.`;
  }
}

export type PullRequestTargetError =
  | PullRequestUrlInvalidError
  | PullRequestTargetIncompleteError
  | PullRequestHostRequiredError
  | PullRequestUrlUnavailableError;

export interface ResolvedPullRequestTarget {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

function projectHostAndProvider(project: OrchestrationProjectShell | undefined): {
  readonly host: string | null;
  readonly kind: SourceControlProviderKind | null;
} {
  const identity = project?.repositoryIdentity;
  const kind = identity?.provider ?? null;
  if (!identity || kind === null) return { host: null, kind: null };
  return {
    host: sourceControlDefinitions.changeRequestHost(identity, kind),
    kind,
  };
}

/** The pull request an agent named, under the rules link_pull_request uses. */
export const resolvePullRequestTarget = Effect.fn("PullRequestTargets.resolve")(function* (
  input: PullRequestReadTarget,
  project: OrchestrationProjectShell | undefined,
) {
  if (input.url !== undefined) {
    const parsed = sourceControlDefinitions.parseChangeRequestUrl(input.url)?.link;
    if (parsed === undefined) {
      return yield* new PullRequestUrlInvalidError({});
    }
    return {
      ...normalizeThreadPullRequestKey(parsed),
      url: canonicalizeGitCafePullRequestUrl(input.url),
    } satisfies ResolvedPullRequestTarget;
  }
  const repository =
    input.repository?.toLowerCase() ??
    (project?.repositoryIdentity == null
      ? undefined
      : sourceControlDefinitions.repositorySelector(project.repositoryIdentity)?.toLowerCase());
  if (repository === undefined || input.number === undefined) {
    return yield* new PullRequestTargetIncompleteError({});
  }
  const projectHost = projectHostAndProvider(project);
  const host = (input.host ?? projectHost.host)?.toLowerCase();
  if (host === undefined) {
    return yield* new PullRequestHostRequiredError({});
  }
  // Without a URL, a public forge host says what shape its change request URLs take;
  // any other host is taken to run the project's own forge.
  const recognizedKind = sourceControlDefinitions.recognizeRemote(`https://${host}`)?.kind;
  const kind =
    sourceControlDefinitions.findByPublicHost(host)?.kind ??
    (recognizedKind === "gitcafe" ? recognizedKind : projectHost.kind);
  const url =
    kind === null
      ? null
      : sourceControlDefinitions.get(kind).changeRequestUrl({
          host,
          repository,
          number: input.number,
          remoteUrl: project?.repositoryIdentity?.locator.remoteUrl,
        });
  if (url === null) {
    return yield* new PullRequestUrlUnavailableError({});
  }
  return {
    ...normalizeThreadPullRequestKey({ host, repository, number: input.number, url }),
    url: canonicalizeGitCafePullRequestUrl(url),
  } satisfies ResolvedPullRequestTarget;
});

/** The project whose checkout and credentials read this pull request, the caller's when it fits. */
export function projectForPullRequest(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  target: { readonly host: string; readonly repository: string },
  preferred: OrchestrationProjectShell | undefined,
): OrchestrationProjectShell | undefined {
  // Match the guide service's host-level repository key, including Azure DevOps org/project/_git/repo.
  const matches = (project: OrchestrationProjectShell) => {
    const own = pullRequestSyncKey(
      { projectId: project.id, host: target.host, repository: target.repository, number: 1 },
      project.repositoryIdentity ?? undefined,
    );
    const projectKey =
      project.repositoryIdentity == null
        ? null
        : pullRequestSyncKey(
            {
              projectId: project.id,
              repository:
                sourceControlDefinitions.repositorySelector(project.repositoryIdentity) ?? "",
              number: 1,
            },
            project.repositoryIdentity,
          );
    const origin = project.repositoryIdentity?.origin;
    if (
      origin !== undefined &&
      own !== null &&
      sourceControlDefinitions.canonicalRepositoryKey(origin.canonicalKey) ===
        sourceControlDefinitions.canonicalRepositoryKey(`${own.host}/${own.repository}`)
    )
      return true;
    return (
      own !== null &&
      projectKey !== null &&
      own.host === projectKey.host &&
      own.repository === projectKey.repository
    );
  };
  if (preferred !== undefined && matches(preferred)) return preferred;
  return projects.find(matches);
}

/**
 * Named targets, each resolved and placed in the project that reads it. A target that cannot be
 * resolved keeps its typed failure so a batch answers the others. A `host` without a `url` builds the
 * URL through the project that holds that repository, which need not be the caller's.
 */
export const locatePullRequestTargets = Effect.fn("PullRequestTargets.locate")(function* (
  targets: ReadonlyArray<PullRequestReadTarget>,
  projects: ReadonlyArray<OrchestrationProjectShell>,
  callerProject: OrchestrationProjectShell | undefined,
) {
  const urlProject = (input: PullRequestReadTarget) =>
    input.url === undefined && input.host !== undefined && input.repository !== undefined
      ? (projectForPullRequest(
          projects,
          { host: input.host, repository: input.repository },
          callerProject,
        ) ?? callerProject)
      : callerProject;
  return yield* Effect.forEach(targets, (input) =>
    resolvePullRequestTarget(input, urlProject(input)).pipe(
      Effect.map((target) => ({
        input,
        target,
        project: projectForPullRequest(projects, target, callerProject),
        failure: null,
      })),
      Effect.catch((failure) =>
        Effect.succeed({ input, target: null, project: undefined, failure }),
      ),
    ),
  );
});
