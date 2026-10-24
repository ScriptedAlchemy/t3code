import {
  CommandId,
  OrchestratorMcpFailure,
  PeerCatalogUnavailable,
  TargetIsSourceEnvironment,
  ThreadId,
  type ConnectedEnvironmentsResult,
  type CrossEnvironmentFailure,
  type CrossEnvironmentLaunchRequest,
  type CrossEnvironmentLaunchResult,
  type OrchestrationProjectShell,
  type ProjectId,
  repositoryMatchViewFromProjects,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as CrossEnvironmentBridge from "./CrossEnvironmentBridge.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { type StartedModes } from "./McpToolAccess.ts";
import { unavailable } from "./threadAccess.ts";

export class CrossEnvironmentMcpService extends Context.Service<
  CrossEnvironmentMcpService,
  {
    readonly list: (
      scope: McpInvocationContext.McpInvocationScope,
    ) => Effect.Effect<
      ConnectedEnvironmentsResult,
      CrossEnvironmentFailure | OrchestratorMcpFailure
    >;
    readonly launch: (
      scope: McpInvocationContext.McpInvocationScope,
      input: CrossEnvironmentLaunchRequest,
      modes: StartedModes,
    ) => Effect.Effect<
      CrossEnvironmentLaunchResult,
      CrossEnvironmentFailure | OrchestratorMcpFailure
    >;
  }
>()("t3/mcp/CrossEnvironmentMcpService") {}

const stablePart = (value: string) => encodeURIComponent(value);

const identifiedProjects = (shells: readonly OrchestrationProjectShell[]) => {
  const projects: { id: ProjectId; identity: RepositoryIdentity }[] = [];
  for (const shell of shells) {
    if (shell.repositoryIdentity != null) {
      projects.push({ id: shell.id, identity: shell.repositoryIdentity });
    }
  }
  return projects;
};

const make = Effect.gen(function* () {
  const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
  const hostResources = yield* HostResources.HostResources;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const callerDescriptor = Effect.fn("CrossEnvironmentMcpService.callerDescriptor")(function* (
    scope: McpInvocationContext.McpInvocationScope,
  ) {
    const descriptor = yield* environment.getDescriptor;
    if (descriptor.environmentId !== scope.environmentId) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential belongs to another environment.",
      });
    }
    return descriptor;
  });

  const sourceProjectId = Effect.fn("CrossEnvironmentMcpService.sourceProjectId")(function* (
    scope: McpInvocationContext.McpInvocationScope,
  ) {
    if (scope.thread === undefined) {
      return undefined;
    }
    const shell = yield* threads.getThreadShell(scope.thread.threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "Could not read the source thread while listing connected environments.",
          {
            cause: error,
          },
        ).pipe(Effect.as(null)),
      ),
    );
    return shell?.projectId;
  });

  const list = Effect.fn("CrossEnvironmentMcpService.list")(function* (
    scope: McpInvocationContext.McpInvocationScope,
  ) {
    const descriptor = yield* callerDescriptor(scope);
    if (yield* bridge.hasSubscriber) {
      const projectId = yield* sourceProjectId(scope);
      return yield* bridge.askList(
        projectId === undefined
          ? { callerEnvironmentId: descriptor.environmentId }
          : { callerEnvironmentId: descriptor.environmentId, sourceProjectId: projectId },
      );
    }
    const shells = yield* projects.listShells().pipe(Effect.mapError(unavailable));
    const sourceId = yield* sourceProjectId(scope);
    const source = shells.find((shell) => shell.id === sourceId)?.repositoryIdentity;
    const resources = yield* hostResources.read;
    const receivedAt = yield* Clock.currentTimeMillis;
    return {
      callerEnvironmentId: descriptor.environmentId,
      environments: [
        {
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          isCaller: true,
          resources,
          receivedAt,
          repository: repositoryMatchViewFromProjects(source, identifiedProjects(shells)),
        },
      ],
    };
  });

  const launch = Effect.fn("CrossEnvironmentMcpService.launch")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: CrossEnvironmentLaunchRequest,
    modes: StartedModes,
  ) {
    const descriptor = yield* callerDescriptor(scope);
    if (
      input.target.kind === "environment" &&
      input.target.environmentId === descriptor.environmentId
    ) {
      return yield* new TargetIsSourceEnvironment({ environmentId: descriptor.environmentId });
    }
    if (!(yield* bridge.hasSubscriber)) {
      return yield* new PeerCatalogUnavailable();
    }
    const threadScope = yield* McpInvocationContext.requireThreadScope(
      scope,
      "t3_environment_launch",
    );
    const shell = yield* threads
      .getThreadShell(threadScope.thread.threadId)
      .pipe(Effect.mapError(unavailable));
    if (shell === null) {
      return yield* unavailable();
    }
    const requestKey = input.clientRequestId;
    const ask = {
      callerEnvironmentId: descriptor.environmentId,
      sourceProjectId: shell.projectId,
      commandId: CommandId.make(
        [
          "command",
          "mcp",
          stablePart(scope.requestNamespace),
          stablePart("cross-environment-launch"),
          stablePart(requestKey),
        ].join(":"),
      ),
      threadId: ThreadId.make(
        ["thread", "mcp", stablePart(scope.requestNamespace), stablePart(requestKey), "0"].join(
          ":",
        ),
      ),
      target: input.target,
      title: input.title,
      runtimeMode: modes.runtimeMode,
      interactionMode: modes.interactionMode,
    };
    switch (input.kind) {
      case "run":
        return yield* bridge.askLaunch({ ...ask, kind: "run", message: input.message });
      case "thread":
        return yield* bridge.askLaunch({
          ...ask,
          kind: "thread",
          ...(input.message === undefined ? {} : { message: input.message }),
        });
      default: {
        const unexpected: never = input;
        return unexpected;
      }
    }
  });

  return CrossEnvironmentMcpService.of({ list, launch });
});

export const layer = Layer.effect(CrossEnvironmentMcpService, make);
