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
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
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
      "cross-environment-launch",
      encodeURIComponent(environmentId),
      encodeURIComponent(threadId),
      encodeURIComponent(requestKey),
    ].join(":"),
  );

const stableThreadId = (requestKey: string) =>
  ThreadId.make(
    [
      "thread",
      "mcp",
      "cross-environment-launch",
      encodeURIComponent(environmentId),
      encodeURIComponent(threadId),
      encodeURIComponent(requestKey),
    ].join(":"),
  );

const toolLayer = <BridgeE, BridgeR>(input: {
  readonly bridge: Layer.Layer<CrossEnvironmentBridge.CrossEnvironmentBridge, BridgeE, BridgeR>;
  readonly resources: Effect.Effect<HostResourcesSnapshot>;
  readonly shells: Effect.Effect<readonly OrchestrationProjectShell[]>;
  readonly invocationScope?: typeof scope;
  readonly databasePath?: string;
}) =>
  McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
    Layer.provideMerge(CrossEnvironmentMcpService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, input.invocationScope ?? scope),
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
        input.bridge.pipe(
          Layer.provide([
            NodeCrypto.layer,
            input.databasePath === undefined
              ? SqlitePersistence.layerMemory
              : SqlitePersistence.layerFromPath(input.databasePath).pipe(
                  Layer.provide(NodeServices.layer),
                ),
          ]),
        ),
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
            askLaunch: () =>
              Ref.set(asked, true).pipe(Effect.andThen(Effect.fail(new PeerCatalogUnavailable()))),
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
    expect(yield* Ref.get(asked)).toBe(true);
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
            askLaunch: () =>
              Ref.set(asked, true).pipe(Effect.andThen(Effect.fail(new PeerCatalogUnavailable()))),
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
        return bridge
          .claim("client-1", {
            requestId: ask.requestId,
            environmentId: peerId,
            projectId,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "peer-model" },
          })
          .pipe(
            Effect.andThen(
              bridge.fulfill("client-1", {
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
              }),
            ),
          );
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
      expect(asks.map((ask) => ask.commandId)).toEqual([stableCommandId("req-1")]);
      expect(asks.map((ask) => ask.threadId)).toEqual([expectedThreadId]);
      expect(asks.map((ask) => ask.sourceProjectId)).toEqual([projectId]);
      expect(asks.map((ask) => ask.runtimeMode)).toEqual(["full-access"]);
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

it.effect(
  "keeps destination command and thread ids stable when the provider namespace changes",
  () =>
    Effect.gen(function* () {
      const asks: CrossEnvironmentLaunchAsk[] = [];
      const bridge = Layer.mock(CrossEnvironmentBridge.CrossEnvironmentBridge)({
        hasSubscriber: Effect.succeed(true),
        askLaunch: (ask) => {
          asks.push({ ...ask, op: "launch", requestId: "request" });
          return Effect.succeed({
            environmentId: peerId,
            projectId,
            threadId: ask.threadId,
            runId: null,
            status: null,
            kind: ask.kind,
          });
        },
      });
      for (const requestNamespace of ["before-restart", "after-restart"]) {
        yield* toolResult("t3_environment_launch", {
          target: { kind: "load_balanced" },
          kind: "run",
          title: "Ship it",
          message: "do the thing",
          clientRequestId: "same-request",
        }).pipe(
          Effect.provide(
            toolLayer({
              bridge,
              resources: Effect.die("unused"),
              shells: Effect.die("unused"),
              invocationScope: { ...scope, requestNamespace },
            }),
          ),
        );
      }
      expect(asks).toHaveLength(2);
      expect(asks[1]?.commandId).toBe(asks[0]?.commandId);
      expect(asks[1]?.threadId).toBe(asks[0]?.threadId);
    }),
);

it.effect.each([false, true])(
  "reuses a saved destination after closing the database and reminting credentials (confirmed: %s)",
  (confirmed) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-cross-environment-restart-",
      });
      const database = `${directory}/state.sqlite`;
      const destination = {
        environmentId: peerId,
        projectId,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "original-model" },
      };
      const asks: CrossEnvironmentLaunchAsk[] = [];
      const params = {
        target: { kind: "load_balanced" },
        kind: "run",
        title: "Survive restart",
        message: "do the thing once",
        clientRequestId: "durable-request",
      };
      for (const [index, requestNamespace] of ["before-restart", "after-restart"].entries()) {
        const result = yield* Effect.gen(function* () {
          const bridge = yield* CrossEnvironmentBridge.CrossEnvironmentBridge;
          if (index === 0 || !confirmed) {
            const stream = yield* bridge.listen(`client-${index}`);
            const request = yield* toolResult("t3_environment_launch", params).pipe(
              Effect.forkScoped,
            );
            const ask = Option.getOrThrow(
              yield* Stream.runHead(Stream.take(stream, 1)).pipe(
                Effect.raceFirst(
                  Fiber.join(request).pipe(
                    Effect.flatMap((result) =>
                      Effect.die(
                        new Error(`Launch ended before dispatch: ${JSON.stringify(result)}`),
                      ),
                    ),
                  ),
                ),
              ),
            );
            if (ask.op !== "launch") return yield* Effect.die("Expected a launch");
            asks.push(ask);
            if (index === 1) {
              expect(ask.target).toEqual({ kind: "environment", environmentId: peerId });
              expect(ask.destination).toEqual(destination);
              expect(ask.commandId).toBe(asks[0]?.commandId);
              expect(ask.threadId).toBe(asks[0]?.threadId);
            }
            expect(
              yield* bridge.claim(`client-${index}`, { requestId: ask.requestId, ...destination }),
            ).toBe(true);
            if (index === 0 && !confirmed) {
              yield* Fiber.interrupt(request);
              return null;
            }
            yield* bridge.fulfill(`client-${index}`, {
              requestId: ask.requestId,
              op: "launch",
              result: {
                environmentId: peerId,
                projectId,
                threadId: ask.threadId,
                runId: RunId.make("original-run"),
                status: "running",
                kind: ask.kind,
              },
            });
            return yield* Fiber.join(request);
          }
          expect(yield* bridge.hasSubscriber).toBe(false);
          return yield* toolResult("t3_environment_launch", params);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            toolLayer({
              bridge: CrossEnvironmentBridge.layer,
              databasePath: database,
              resources: Effect.die("unused"),
              shells: Effect.die("unused"),
              invocationScope: {
                ...scope,
                requestNamespace,
                thread: { ...scope.thread, providerSessionId: requestNamespace },
              },
            }),
          ),
        );
        if (index === 1 || confirmed) {
          expect(result).toMatchObject({
            environmentId: peerId,
            threadId: asks[0]?.threadId,
            runId: RunId.make("original-run"),
          });
        }
      }
      expect(asks).toHaveLength(confirmed ? 1 : 2);
    }).pipe(Effect.provide(NodeServices.layer)),
);
