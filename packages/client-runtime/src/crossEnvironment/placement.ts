import {
  CrossEnvironmentLaunchUncertain,
  ORCHESTRATION_V2_WS_METHODS,
  SourceIdentityUnresolved,
  TargetModelUnavailable,
  WS_METHODS,
  type ConnectedEnvironmentView,
  type ConnectedEnvironmentsResult,
  type CrossEnvironmentFailure,
  type CrossEnvironmentLaunchKind,
  type CrossEnvironmentLaunchResult,
  type CrossEnvironmentTarget,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadLaunchInput,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type CommandId,
  repositoryMatchViewFromProjects,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { presentConnectionState } from "../connection/presentation.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { request } from "../rpc/client.ts";
import {
  activeProjectsFromShells,
  repositoryMatchView,
  resolveLaunchTarget,
  type ActiveProject,
  type MatchedPeerProject,
} from "./match.ts";
import * as EnvironmentProjectCatalog from "./catalog.ts";
import { readLoadBalancingWeights } from "./weights.ts";

const isSourceIdentityUnresolved = Schema.is(SourceIdentityUnresolved);

export class CrossEnvironmentPlacement extends Context.Service<
  CrossEnvironmentPlacement,
  {
    readonly list: (input: {
      readonly callerEnvironmentId: EnvironmentId;
      readonly source: ActiveProject | SourceIdentityUnresolved | null;
    }) => Effect.Effect<ConnectedEnvironmentsResult, CrossEnvironmentFailure>;
    readonly launch: (input: {
      readonly callerEnvironmentId: EnvironmentId;
      readonly source: ActiveProject | SourceIdentityUnresolved;
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly target: CrossEnvironmentTarget;
      readonly kind: CrossEnvironmentLaunchKind;
      readonly title: string;
      readonly message?: string;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly claim: (environmentId: EnvironmentId) => Effect.Effect<boolean>;
    }) => Effect.Effect<CrossEnvironmentLaunchResult, CrossEnvironmentFailure>;
  }
>()("@t3tools/client-runtime/crossEnvironment/placement/CrossEnvironmentPlacement") {}

const toLaunchThreadPayload = (input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly matched: MatchedPeerProject;
  readonly title: string;
  readonly message: string | undefined;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): OrchestrationV2ThreadLaunchInput => {
  const text = input.message?.trim() ?? "";
  return {
    commandId: input.commandId,
    threadId: input.threadId,
    creationSource: "mcp",
    projectId: input.matched.projectId,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    workspaceStrategy: { type: "root" },
    ...(text.length === 0 ? {} : { initialMessage: { text, attachments: [] } }),
  };
};

const projectsOf = (shells: readonly OrchestrationProjectShell[]) =>
  activeProjectsFromShells(
    shells.map((shell) => ({ id: shell.id, repositoryIdentity: shell.repositoryIdentity ?? null })),
  );

const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const catalog = yield* EnvironmentProjectCatalog.EnvironmentProjectCatalog;

  const sampleResources = Effect.fn("CrossEnvironmentPlacement.sampleResources")(function* (
    environmentId: EnvironmentId,
  ) {
    return yield* registry
      .run(
        environmentId,
        request(WS_METHODS.serverGetHostResources, {}).pipe(Effect.timeout("5 seconds")),
      )
      .pipe(Effect.catch(() => Effect.succeed(null)));
  });

  const matchView = (
    source: ActiveProject | SourceIdentityUnresolved | null,
    projects: readonly ActiveProject[],
  ) =>
    source === null
      ? repositoryMatchViewFromProjects(null, projects)
      : repositoryMatchView(source, projects);

  const observe = Effect.fn("CrossEnvironmentPlacement.observe")(function* (input: {
    readonly source: ActiveProject | SourceIdentityUnresolved | null;
  }) {
    const entries = yield* SubscriptionRef.get(registry.entries);
    return yield* Effect.forEach(
      [...entries.values()],
      (entry) =>
        Effect.gen(function* () {
          const environmentId = entry.target.environmentId;
          const state = yield* registry.state(environmentId).pipe(Effect.option);
          if (Option.isNone(state)) {
            return null;
          }
          const phase = presentConnectionState(state.value).phase;
          if (phase !== "connected") {
            return { _tag: "notConnected" as const, environmentId, phase };
          }
          const shells = yield* catalog.projects(environmentId);
          const projects = projectsOf(shells);
          const resources = yield* sampleResources(environmentId);
          const receivedAt = yield* Clock.currentTimeMillis;
          const view: ConnectedEnvironmentView = {
            environmentId,
            label: entry.target.label,
            isCaller: false,
            resources,
            receivedAt,
            repository: matchView(input.source, projects),
          };
          return { _tag: "connected" as const, view, projects: shells };
        }),
      { concurrency: "unbounded" },
    );
  });

  const list = Effect.fn("CrossEnvironmentPlacement.list")(function* (input: {
    readonly callerEnvironmentId: EnvironmentId;
    readonly source: ActiveProject | SourceIdentityUnresolved | null;
  }) {
    const observed = yield* observe({ source: input.source });
    const environments: ConnectedEnvironmentView[] = [];
    for (const row of observed) {
      if (row === null || row._tag !== "connected") continue;
      environments.push({
        ...row.view,
        isCaller: row.view.environmentId === input.callerEnvironmentId,
      });
    }
    return { callerEnvironmentId: input.callerEnvironmentId, environments };
  });

  const launch = Effect.fn("CrossEnvironmentPlacement.launch")(function* (input: {
    readonly callerEnvironmentId: EnvironmentId;
    readonly source: ActiveProject | SourceIdentityUnresolved;
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly target: CrossEnvironmentTarget;
    readonly kind: CrossEnvironmentLaunchKind;
    readonly title: string;
    readonly message?: string;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly claim: (environmentId: EnvironmentId) => Effect.Effect<boolean>;
  }) {
    if (isSourceIdentityUnresolved(input.source)) {
      return yield* input.source;
    }
    const observed = yield* observe({ source: input.source });
    const connected = [];
    const notConnected = [];
    for (const row of observed) {
      if (row === null) continue;
      switch (row._tag) {
        case "connected":
          connected.push({
            environmentId: row.view.environmentId,
            resources: row.view.resources,
            receivedAt: row.view.receivedAt,
            repository: row.view.repository,
            projects: projectsOf(row.projects),
            shells: row.projects,
          });
          break;
        case "notConnected":
          notConnected.push({ environmentId: row.environmentId, phase: row.phase });
          break;
        default: {
          const unexpected: never = row;
          return unexpected;
        }
      }
    }
    const resolved = resolveLaunchTarget({
      callerEnvironmentId: input.callerEnvironmentId,
      source: input.source,
      target: input.target,
      connected,
      notConnected,
      weights: readLoadBalancingWeights(),
      now: yield* Clock.currentTimeMillis,
    });
    if ("_tag" in resolved) {
      return yield* resolved;
    }
    const chosen = connected.find((row) => row.environmentId === resolved.environmentId);
    const modelSelection =
      chosen?.shells?.find((shell) => shell.id === resolved.projectId)?.defaultModelSelection ??
      null;
    if (modelSelection === null) {
      return yield* new TargetModelUnavailable({ projectId: resolved.projectId });
    }
    const payload = toLaunchThreadPayload({
      commandId: input.commandId,
      threadId: input.threadId,
      matched: resolved,
      title: input.title,
      message: input.message,
      modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
    });
    if (!(yield* input.claim(resolved.environmentId))) {
      return yield* new CrossEnvironmentLaunchUncertain({
        threadId: input.threadId,
        environmentId: resolved.environmentId,
      });
    }
    const launched = yield* registry
      .run(resolved.environmentId, request(ORCHESTRATION_V2_WS_METHODS.launchThread, payload))
      .pipe(
        Effect.timeout("45 seconds"),
        Effect.tapError((error) =>
          Effect.logWarning("The destination environment did not confirm the launch.", {
            ...safeErrorLogAttributes(error),
          }),
        ),
        Effect.mapError(
          () =>
            new CrossEnvironmentLaunchUncertain({
              threadId: input.threadId,
              environmentId: resolved.environmentId,
            }),
        ),
      );
    const run = launched.projection.runs.at(-1) ?? null;
    return {
      environmentId: resolved.environmentId,
      projectId: resolved.projectId,
      threadId: launched.threadId,
      runId: run?.id ?? null,
      status: run?.status ?? null,
      kind: input.kind,
    };
  });

  return CrossEnvironmentPlacement.of({ list, launch });
});

export const layer = Layer.effect(CrossEnvironmentPlacement, make);
