import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  PeerCatalogUnavailable,
  ProjectId,
  ProviderInstanceId,
  RunId,
  TargetIsSourceEnvironment,
  ThreadId,
  type CrossEnvironmentLaunchAsk,
  type HostResourcesSnapshot,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as Settings from "../../../serverSettings.ts";
import * as CrossEnvironmentBridge from "../../CrossEnvironmentBridge.ts";
import * as CrossEnvironmentMcpService from "../../CrossEnvironmentMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:caller");
const peerId = EnvironmentId.make("environment:peer");
const projectId = ProjectId.make("project:mcp-test");
const threadId = ThreadId.make("thread:cross-env");
const namespace = "provider:cross-env";

const callerResources: HostResourcesSnapshot = {
  sampledAt: 4,
  cpuUtilization: 0.25,
  cpuCount: 8,
  availableMemoryBytes: 4_000,
  totalMemoryBytes: 8_000,
};

const peerResources: HostResourcesSnapshot = {
  sampledAt: 9,
  cpuUtilization: 0.3,
  cpuCount: 2,
  availableMemoryBytes: 500,
  totalMemoryBytes: 4_000,
};

const projectShell: OrchestrationProjectShell = {
  id: projectId,
  title: "Repo",
  workspaceRoot: "/repo",
  repositoryIdentity: {
    canonicalKey: "github.com/org/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/org/repo.git",
    },
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const scope = {
  environmentId,
  requestNamespace: namespace,
  thread: {
    threadId,
    providerSessionId: namespace,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

const stableCommandId = (requestKey: string) =>
  CommandId.make(
    [
      "command",
      "mcp",
      encodeURIComponent(namespace),
      encodeURIComponent("cross-environment-launch"),
      encodeURIComponent(requestKey),
    ].join(":"),
  );

const stableThreadId = (requestKey: string) =>
  ThreadId.make(
    ["thread", "mcp", encodeURIComponent(namespace), encodeURIComponent(requestKey), "0"].join(":"),
  );

const toolLayer = <BridgeR>(input: {
  readonly bridge: Layer.Layer<CrossEnvironmentBridge.CrossEnvironmentBridge, never, BridgeR>;
  readonly resources: Effect.Effect<HostResourcesSnapshot>;
  readonly shells: Effect.Effect<readonly OrchestrationProjectShell[]>;
}) =>
  McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
    Layer.provideMerge(CrossEnvironmentMcpService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
        }),
        Layer.mock(Environment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.mock(HostResources.HostResources)({ read: input.resources }),
        Layer.mock(ProjectService.ProjectService)({ listShells: () => input.shells }),
        input.bridge.pipe(Layer.provide(NodeCrypto.layer)),
      ),
    ),
  );

const toolResult = (name: "t3_connected_environments" | "t3_environment_launch", params: object) =>
  Effect.gen(function* () {
    const toolkit = yield* EnvironmentToolkit;
    const collected = yield* toolkit.handle(name, params).pipe(Stream.unwrap, Stream.runCollect);
    return collected.at(-1)?.result;
  });

it.effect("returns this server and its host resources when no client is subscribed", () =>
  Effect.gen(function* () {
    const result = yield* toolResult("t3_connected_environments", {});
    expect(result).toEqual({
      callerEnvironmentId: environmentId,
      environments: [
        {
          environmentId,
          label: "Test",
          isCaller: true,
          resources: callerResources,
          receivedAt: 0,
          repository: { tag: "matched", projectId },
        },
      ],
    });
    expect(result).not.toHaveProperty("taskId");
  }).pipe(
    Effect.provide(
      toolLayer({
        bridge: CrossEnvironmentBridge.layer,
        resources: Effect.succeed(callerResources),
        shells: Effect.succeed([projectShell]),
      }),
    ),
  ),
);

it.effect("returns the peer resources a subscribed client reports", () =>
  Effect.gen(function* () {
    const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
    const stream = yield* bridge.listen("client-1");
    const reported = {
      callerEnvironmentId: environmentId,
      environments: [
        {
          environmentId: peerId,
          label: "Peer",
          isCaller: false,
          resources: peerResources,
          receivedAt: 9,
          repository: { tag: "matched" as const, projectId },
        },
      ],
    };
    yield* Stream.runForEach(stream, (ask) =>
      ask.op === "list"
        ? bridge.fulfill("client-1", { requestId: ask.requestId, op: "list", result: reported })
        : Effect.void,
    ).pipe(Effect.forkScoped);
    const result = yield* toolResult("t3_connected_environments", {});
    expect(result).toEqual(reported);
    expect(result).not.toHaveProperty("taskId");
  }).pipe(
    Effect.provide(
      toolLayer({
        bridge: CrossEnvironmentBridge.layer,
        resources: Effect.die("local resources are not the peer catalog"),
        shells: Effect.die("local projects are not the peer catalog"),
      }),
    ),
  ),
);

it.effect("returns PeerCatalogUnavailable for a launch when no client is subscribed", () =>
  Effect.gen(function* () {
    const asked = yield* Ref.make(false);
    const result = yield* toolResult("t3_environment_launch", {
      target: { kind: "environment", environmentId: peerId },
      kind: "run",
      title: "Ship it",
      message: "do the thing",
      clientRequestId: "req-offline",
    }).pipe(
      Effect.provide(
        toolLayer({
          bridge: Layer.mock(CrossEnvironmentBridge.CrossEnvironmentBridge)({
            hasSubscriber: Effect.succeed(false),
            askLaunch: () => Ref.set(asked, true).pipe(Effect.andThen(Effect.die("asked"))),
            askList: () => Effect.die("listed"),
          }),
          resources: Effect.die("unused"),
          shells: Effect.die("unused"),
        }),
      ),
    );
    expect(result).toBeInstanceOf(PeerCatalogUnavailable);
    expect(result).toMatchObject({ _tag: "PeerCatalogUnavailable" });
    expect(result).not.toHaveProperty("taskId");
    expect(yield* Ref.get(asked)).toBe(false);
  }),
);

it.effect("returns TargetIsSourceEnvironment before asking this server to launch itself", () =>
  Effect.gen(function* () {
    const asked = yield* Ref.make(false);
    const result = yield* toolResult("t3_environment_launch", {
      target: { kind: "environment", environmentId },
      kind: "thread",
      title: "Ship it",
      clientRequestId: "req-self",
    }).pipe(
      Effect.provide(
        toolLayer({
          bridge: Layer.mock(CrossEnvironmentBridge.CrossEnvironmentBridge)({
            hasSubscriber: Effect.succeed(true),
            askLaunch: () => Ref.set(asked, true).pipe(Effect.andThen(Effect.die("asked"))),
            askList: () => Effect.die("listed"),
          }),
          resources: Effect.die("unused"),
          shells: Effect.die("unused"),
        }),
      ),
    );
    expect(result).toBeInstanceOf(TargetIsSourceEnvironment);
    expect(result).not.toHaveProperty("taskId");
    expect(yield* Ref.get(asked)).toBe(false);
  }),
);

it.effect.each(["run", "thread"] as const)(
  "returns the destination thread a client fulfills for a %s launch",
  (kind) =>
    Effect.gen(function* () {
      const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
      const stream = yield* bridge.listen("client-1");
      const asks: CrossEnvironmentLaunchAsk[] = [];
      yield* Stream.runForEach(stream, (ask) => {
        if (ask.op !== "launch") return Effect.void;
        asks.push(ask);
        return bridge.fulfill("client-1", {
          requestId: ask.requestId,
          op: "launch",
          result: {
            environmentId: peerId,
            projectId,
            threadId: ask.threadId,
            runId: RunId.make("run-remote"),
            status: "running",
            kind: ask.kind,
          },
        });
      }).pipe(Effect.forkScoped);
      const params = {
        target: { kind: "environment" as const, environmentId: peerId },
        title: "Ship it",
        clientRequestId: "req-1",
        ...(kind === "run"
          ? { kind: "run" as const, message: "do the thing" }
          : { kind: "thread" as const }),
      };
      const first = yield* toolResult("t3_environment_launch", params);
      const second = yield* toolResult("t3_environment_launch", params);
      const expectedThreadId = stableThreadId("req-1");
      expect(first).toEqual({
        environmentId: peerId,
        projectId,
        threadId: expectedThreadId,
        runId: RunId.make("run-remote"),
        status: "running",
        kind,
      });
      expect(first).not.toHaveProperty("taskId");
      expect(second).toEqual(first);
      expect(asks.map((ask) => ask.commandId)).toEqual([
        stableCommandId("req-1"),
        stableCommandId("req-1"),
      ]);
      expect(asks.map((ask) => ask.threadId)).toEqual([expectedThreadId, expectedThreadId]);
      expect(asks.map((ask) => ask.sourceProjectId)).toEqual([projectId, projectId]);
      expect(asks.map((ask) => ask.runtimeMode)).toEqual(["full-access", "full-access"]);
    }).pipe(
      Effect.provide(
        toolLayer({
          bridge: CrossEnvironmentBridge.layer,
          resources: Effect.die("unused"),
          shells: Effect.die("unused"),
        }),
      ),
    ),
);
