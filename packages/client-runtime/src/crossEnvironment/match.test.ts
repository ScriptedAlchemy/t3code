import {
  EnvironmentId,
  ProjectId,
  SourceIdentityUnresolved,
  type HostResourcesSnapshot,
  type RepositoryIdentity,
  type RepositoryMatchView,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import { chooseLoadBalancedEnvironment } from "../load-balancing.ts";
import {
  activeProjectsFromShells,
  parseSourceProject,
  repositoryMatchView,
  resolveLaunchTarget,
  type ActiveProject,
  type ConnectedPeer,
  type LaunchResolution,
  type MatchedPeerProject,
  type NotConnectedPeer,
} from "./match.ts";
import * as MatchModule from "./match.ts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

type DisconnectedPhase = NotConnectedPeer["phase"];
const _phasesMatch = true as Equal<
  DisconnectedPhase,
  Exclude<EnvironmentConnectionPhase, "connected">
>;

type PrivateExport = Extract<
  keyof typeof MatchModule,
  "matchedPeerProject" | "matchPeerProject" | "matchedPeerProjectBrand" | "sealMatchedPeerProject"
>;
const _privateExportsStayHidden = true as [PrivateExport] extends [never] ? true : never;

void _phasesMatch;
void _privateExportsStayHidden;

const now = 100_000;
const resources: HostResourcesSnapshot = {
  sampledAt: now,
  cpuUtilization: 0.2,
  cpuCount: 8,
  availableMemoryBytes: 8_000,
  totalMemoryBytes: 16_000,
};

const env = (id: string) => EnvironmentId.make(id);
const projectId = (id: string) => ProjectId.make(id);

const identity = (canonicalKey: string, origin?: string): RepositoryIdentity => ({
  canonicalKey,
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${canonicalKey}` },
  ...(origin === undefined ? {} : { origin: { canonicalKey: origin } }),
});

const active = (id: string, canonicalKey: string, origin?: string): ActiveProject => ({
  id: projectId(id),
  identity: identity(canonicalKey, origin),
});

const peer = (
  environmentId: string,
  projects: readonly ActiveProject[],
  repository: RepositoryMatchView,
  patch?: Partial<Pick<ConnectedPeer, "resources" | "receivedAt">>,
): ConnectedPeer => ({
  environmentId: env(environmentId),
  projects,
  repository,
  resources: patch?.resources === undefined ? resources : patch.resources,
  receivedAt: patch?.receivedAt ?? now,
});

const callerId = env("laptop");

const resolve = (input: {
  readonly source: ActiveProject;
  readonly target: Parameters<typeof resolveLaunchTarget>[0]["target"];
  readonly connected?: readonly ConnectedPeer[];
  readonly notConnected?: readonly NotConnectedPeer[];
  readonly weights?: Readonly<Record<string, number>>;
  readonly now?: number;
}): LaunchResolution =>
  resolveLaunchTarget({
    callerEnvironmentId: callerId,
    source: input.source,
    target: input.target,
    connected: input.connected ?? [],
    notConnected: input.notConnected ?? [],
    weights: input.weights ?? {},
    now: input.now ?? now,
  });

const expectMatched = (result: LaunchResolution): MatchedPeerProject => {
  if ("_tag" in result) {
    expect.fail(result._tag);
  }
  return result;
};

describe("resolveLaunchTarget", () => {
  it("returns the target project when grouping keys match and project ids differ", () => {
    const source = active("source-proj", "github.com/me/repo", "github.com/org/repo");
    const target = active("target-proj", "github.com/other/repo", "github.com/org/repo");
    const result = expectMatched(
      resolve({
        source,
        target: { kind: "environment", environmentId: env("studio") },
        connected: [peer("studio", [target], repositoryMatchView(source, [target]))],
      }),
    );

    expect(result.projectId).toBe(target.id);
    expect(result.projectId).not.toBe(source.id);
    expect(result.environmentId).toBe(env("studio"));
    expect(result.groupingKey).toBe("github.com/org/repo");
  });

  it("keeps a null identity out of ActiveProject and reports a target with no key", () => {
    const shell = { id: projectId("source-proj"), repositoryIdentity: null };
    const parsed = parseSourceProject(shell);
    if (!Schema.is(SourceIdentityUnresolved)(parsed)) {
      expect.fail("null identity became an ActiveProject");
    }
    expect(parsed.projectId).toBe(shell.id);
    expect(
      activeProjectsFromShells([shell, { id: projectId("also-null"), repositoryIdentity: null }]),
    ).toEqual([]);

    const source = active("source-proj", "github.com/org/repo");
    const targetProjects = activeProjectsFromShells([
      { id: projectId("target-proj"), repositoryIdentity: null },
    ]);
    const result = resolve({
      source,
      target: { kind: "environment", environmentId: env("studio") },
      connected: [peer("studio", targetProjects, repositoryMatchView(source, targetProjects))],
    });

    expect(result).toMatchObject({
      _tag: "ProjectMissingOnTarget",
      environmentId: env("studio"),
      groupingKey: "github.com/org/repo",
    });
  });

  it("does not match a fork whose origin key differs from the upstream checkout", () => {
    const source = active("upstream", "github.com/org/repo");
    const fork = active("fork", "github.com/org/repo", "github.com/me/repo");
    const result = resolve({
      source,
      target: { kind: "environment", environmentId: env("studio") },
      connected: [peer("studio", [fork], repositoryMatchView(source, [fork]))],
    });

    expect(result).toMatchObject({
      _tag: "ProjectMissingOnTarget",
      environmentId: env("studio"),
      groupingKey: "github.com/org/repo",
    });
  });

  it("returns AmbiguousRepositoryMatch for a named target and for load balancing", () => {
    const source = active("source-proj", "github.com/org/repo");
    const first = active("checkout-a", "github.com/org/repo");
    const second = active("checkout-b", "github.com/other/repo", "github.com/org/repo");
    const projects = [first, second];
    const row = peer("studio", projects, repositoryMatchView(source, projects));

    expect(row.repository).toEqual({
      tag: "ambiguous",
      projectIds: [first.id, second.id],
    });

    const named = resolve({
      source,
      target: { kind: "environment", environmentId: env("studio") },
      connected: [row],
    });
    const balanced = resolve({
      source,
      target: { kind: "load_balanced" },
      connected: [row],
    });

    for (const result of [named, balanced]) {
      expect(result).toMatchObject({
        _tag: "AmbiguousRepositoryMatch",
        environmentId: env("studio"),
        projectIds: [first.id, second.id],
      });
      expect(result).not.toHaveProperty("groupingKey");
    }
  });

  it("returns UnknownEnvironment when the id is in neither catalog", () => {
    const result = resolve({
      source: active("source-proj", "github.com/org/repo"),
      target: { kind: "environment", environmentId: env("missing") },
      notConnected: [{ environmentId: env("offline-other"), phase: "offline" }],
    });

    expect(result).toMatchObject({
      _tag: "UnknownEnvironment",
      environmentId: env("missing"),
    });
  });

  it("returns EnvironmentNotConnected with the peer phase", () => {
    const result = resolve({
      source: active("source-proj", "github.com/org/repo"),
      target: { kind: "environment", environmentId: env("studio") },
      notConnected: [{ environmentId: env("studio"), phase: "offline" }],
    });

    expect(result).toMatchObject({
      _tag: "EnvironmentNotConnected",
      environmentId: env("studio"),
      phase: "offline",
    });
  });

  it("returns TargetIsSourceEnvironment when the named id is the caller", () => {
    const source = active("source-proj", "github.com/org/repo");
    const result = resolve({
      source,
      target: { kind: "environment", environmentId: callerId },
      connected: [peer("laptop", [source], { tag: "matched", projectId: source.id })],
    });

    expect(result).toMatchObject({
      _tag: "TargetIsSourceEnvironment",
      environmentId: callerId,
    });
  });

  it("launches on the environment chooseLoadBalancedEnvironment picks", () => {
    const source = active("source-proj", "github.com/org/repo");
    const studioProject = active("studio-proj", "github.com/org/repo");
    const cloudProject = active("cloud-proj", "github.com/org/repo");
    const callerProject = active("laptop-proj", "github.com/org/repo");
    const elsewhere = active("elsewhere", "github.com/elsewhere/repo");
    const weights: Readonly<Record<string, number>> = { cloud: 10, laptop: 100 };
    const connected = [
      peer("laptop", [callerProject], repositoryMatchView(source, [callerProject]), {
        resources: { ...resources, cpuCount: 32 },
      }),
      peer("studio", [studioProject], repositoryMatchView(source, [studioProject])),
      peer("cloud", [cloudProject], repositoryMatchView(source, [cloudProject])),
      peer("idle", [elsewhere], repositoryMatchView(source, [elsewhere]), {
        resources: { ...resources, cpuCount: 64 },
      }),
    ];
    const foreignMatches = connected.filter(
      (row) => row.environmentId !== callerId && row.repository.tag === "matched",
    );
    const expected = chooseLoadBalancedEnvironment(
      foreignMatches.map((row) => ({
        environmentId: row.environmentId,
        resources: row.resources,
        receivedAt: row.receivedAt,
        weight: weights[row.environmentId] ?? 50,
      })),
      now,
    );

    const result = expectMatched(
      resolve({
        source,
        target: { kind: "load_balanced" },
        connected,
        weights,
      }),
    );

    expect(expected).toBe(env("studio"));
    expect(result.environmentId).toBe(expected);
    expect(result.projectId).toBe(studioProject.id);
  });

  it("returns NoEligibleEnvironment when load balancing returns null", () => {
    const source = active("source-proj", "github.com/org/repo");
    const studioProject = active("studio-proj", "github.com/org/repo");
    const callerProject = active("laptop-proj", "github.com/org/repo");
    const stale = resolve({
      source,
      target: { kind: "load_balanced" },
      connected: [
        peer("laptop", [callerProject], repositoryMatchView(source, [callerProject])),
        peer("studio", [studioProject], repositoryMatchView(source, [studioProject]), {
          receivedAt: now - 15_001,
        }),
      ],
    });
    const excluded = resolve({
      source,
      target: { kind: "load_balanced" },
      connected: [peer("studio", [studioProject], repositoryMatchView(source, [studioProject]))],
      weights: { studio: 0 },
    });

    expect(stale).toMatchObject({ _tag: "NoEligibleEnvironment" });
    expect(excluded).toMatchObject({ _tag: "NoEligibleEnvironment" });
    expect(stale).not.toHaveProperty("environmentId");
    expect(excluded).not.toHaveProperty("environmentId");
  });

  it("does not treat a matched tag as permission to launch", () => {
    const source = active("source-proj", "github.com/org/repo");
    const real = active("real-proj", "github.com/org/repo");
    const other = active("other-proj", "github.com/elsewhere/repo");
    const lyingId = projectId("from-the-view");

    const missingProjects = resolve({
      source,
      target: { kind: "environment", environmentId: env("studio") },
      connected: [peer("studio", [other], { tag: "matched", projectId: lyingId })],
    });
    const balancedMissing = resolve({
      source,
      target: { kind: "load_balanced" },
      connected: [peer("studio", [other], { tag: "matched", projectId: lyingId })],
    });
    const wrongId = expectMatched(
      resolve({
        source,
        target: { kind: "environment", environmentId: env("studio") },
        connected: [peer("studio", [real], { tag: "matched", projectId: lyingId })],
      }),
    );

    expect(missingProjects).toMatchObject({ _tag: "ProjectMissingOnTarget" });
    expect(balancedMissing).toMatchObject({ _tag: "ProjectMissingOnTarget" });
    expect(missingProjects).not.toMatchObject({ projectId: lyingId });
    expect(wrongId.projectId).toBe(real.id);
    expect(wrongId.projectId).not.toBe(lyingId);
  });
});
