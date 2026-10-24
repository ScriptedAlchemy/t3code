import {
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  RunId,
  WS_METHODS,
  type EnvironmentId,
  type HostResourcesSnapshot,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { v2Projection } from "../state/orchestrationV2TestFixtures.ts";

export const hostResources: HostResourcesSnapshot = {
  sampledAt: 0,
  cpuUtilization: 0.1,
  cpuCount: 4,
  availableMemoryBytes: 8_000,
  totalMemoryBytes: 16_000,
};

const connectedState: SupervisorConnectionState = {
  desired: true,
  network: "online",
  phase: "connected",
  stage: null,
  attempt: 1,
  generation: 1,
  lastFailure: null,
  retryAt: null,
};

export interface RecordedLaunch {
  readonly environmentId: EnvironmentId;
  readonly input: OrchestrationV2ThreadLaunchInput;
}

export const projectShell = (input: {
  readonly id: OrchestrationProjectShell["id"];
  readonly canonicalKey: string;
  readonly model: string | null;
}): OrchestrationProjectShell => ({
  id: input.id,
  title: input.id,
  workspaceRoot: `/work/${input.id}`,
  repositoryIdentity: {
    canonicalKey: input.canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `https://${input.canonicalKey}`,
    },
  },
  defaultModelSelection:
    input.model === null
      ? null
      : { instanceId: ProviderInstanceId.make("codex"), model: input.model },
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
});

const launchedProjection = (
  threadId: OrchestrationV2ThreadProjection["thread"]["id"],
): OrchestrationV2ThreadProjection => ({
  ...v2Projection,
  thread: { ...v2Projection.thread, id: threadId },
  runs: [
    {
      id: RunId.make("run-dest"),
      status: "running",
    } as OrchestrationV2ThreadProjection["runs"][number],
  ],
});

export const makePlacementRegistry = Effect.fn("TestCrossEnvironment.makeRegistry")(function* (
  environments: ReadonlyArray<{ readonly id: EnvironmentId; readonly label: string }>,
) {
  const launches: RecordedLaunch[] = [];
  const supervisors = new Map<
    EnvironmentId,
    EnvironmentSupervisor.EnvironmentSupervisor["Service"]
  >();
  const entries = new Map<EnvironmentId, ConnectionCatalogEntry>();
  for (const environment of environments) {
    const target = new PrimaryConnectionTarget({
      environmentId: environment.id,
      label: environment.label,
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    });
    const client = {
      [WS_METHODS.serverGetHostResources]: () => Effect.succeed(hostResources),
      [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input: OrchestrationV2ThreadLaunchInput) =>
        Effect.sync(() => {
          launches.push({ environmentId: environment.id, input });
          return {
            threadId: input.threadId ?? v2Projection.thread.id,
            projection: launchedProjection(input.threadId ?? v2Projection.thread.id),
            resumed: false,
          };
        }),
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession = {
      client,
      initialConfig: Effect.succeed({
        environment: { capabilities: { repositoryIdentity: true } },
      } as never),
      subscribeServerConfig: () => Stream.empty,
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    supervisors.set(
      environment.id,
      EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make(connectedState),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      }),
    );
    entries.set(environment.id, { target, profile: Option.none(), enabled: true });
  }
  const registry = {
    entries: yield* SubscriptionRef.make(entries),
    state: (environmentId: EnvironmentId) =>
      supervisors.has(environmentId)
        ? Effect.succeed(connectedState)
        : Effect.fail(new EnvironmentRegistry.EnvironmentNotRegisteredError({ environmentId })),
    run: <A, E, R>(environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) => {
      const supervisor = supervisors.get(environmentId);
      if (supervisor === undefined) {
        return Effect.fail(
          new EnvironmentRegistry.EnvironmentNotRegisteredError({ environmentId }),
        );
      }
      return effect.pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );
    },
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
  return { launches, registry };
});
