import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { DirectEndpoints } from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as InferenceProxy from "./InferenceProxy.ts";
import { proxyVersion } from "./install.ts";

it.effect(
  "restores hosted accounts, scopes grants to consumers and cuts over a working route atomically",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const state = yield* ServerSecretStore.ServerSecretStore;
        const home = yield* fs.makeTempDirectoryScoped();
        const hostId = EnvironmentId.make("host");
        const peer = { environmentId: EnvironmentId.make("worker"), label: "Workstation" };
        const runtime =
          config.stateDir + "/inference-proxy/runtime/" + proxyVersion + "-darwin-arm64";
        yield* fs.makeDirectory(runtime, { recursive: true });
        yield* fs.writeFileString(runtime + "/cli-proxy-api", "");
        const downloading = yield* Deferred.make<void>();
        const finishDownload = yield* Deferred.make<void>();
        let registryOffline = true;
        let tailnetCatalogDown = false;
        let serving = false;
        let lan = false;
        let rejectNextLaunch = false;
        let currentExit: Deferred.Deferred<void> | undefined;
        let expectRecovery = false;
        const recovered = yield* Deferred.make<void>();
        let starts = 0;
        let stops = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const tailscale =
              ChildProcess.isStandardCommand(command) && command.command === "tailscale";
            if (!tailscale && rejectNextLaunch) {
              rejectNextLaunch = false;
              return yield* PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
              });
            }
            const exited = yield* Deferred.make<void>();
            if (!tailscale) {
              currentExit = exited;
              if (expectRecovery) yield* Deferred.succeed(recovered, undefined);
              yield* Effect.addFinalizer(() => Deferred.succeed(exited, undefined));
              starts++;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  stops++;
                }),
              );
            }
            const stdout = tailscale
              ? Stream.succeed(
                  new TextEncoder().encode(
                    serving
                      ? '{"Web":{"pool.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:12345"}}}}}'
                      : "{}",
                  ),
                )
              : Stream.empty;
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
              exitCode: tailscale
                ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
                : Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              stdin: Sink.drain,
              stdout,
              stderr: Stream.empty,
              all: stdout,
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );
        let catalog: readonly { id: string; owned_by?: string }[] = [];
        let identity = hostId;
        let peerId = hostId;
        const remoteCatalogKeys: (string | undefined)[] = [];
        const http = HttpClient.make((request) => {
          if (registryOffline && request.url.endsWith("/releases/latest"))
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
            );
          if (request.url.endsWith("/releases/latest"))
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  tag_name: "v8.0.61",
                  draft: false,
                  prerelease: false,
                  assets: [
                    {
                      id: 123,
                      name: "CLIProxyAPI_8.0.61_darwin_aarch64.tar.gz",
                      size: 1,
                      digest: "sha256:" + "0".repeat(64),
                    },
                  ],
                }),
              ),
            );
          if (request.url.endsWith("/assets/123"))
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(new Uint8Array(1))),
            ).pipe(
              Effect.tap(() => Deferred.succeed(downloading, undefined)),
              Effect.tap(() => Deferred.await(finishDownload)),
            );
          if (
            request.url.includes("/api/inference") ||
            request.url.includes("/.well-known/t3/environment")
          ) {
            if (request.url.endsWith("/.well-known/t3/environment")) {
              expect(request.headers.authorization).toBeUndefined();
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json({ environmentId: peerId })),
              );
            }
            remoteCatalogKeys.push(request.headers.authorization);
            if (tailnetCatalogDown && request.url.startsWith("https:"))
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 502 })),
              );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                request.url.endsWith("auth-files")
                  ? {
                      files: [
                        {
                          name: "codex:api-key:fixture",
                          provider: "codex",
                          status: "active",
                          runtime_only: true,
                        },
                        {
                          name: "one.json",
                          provider: "codex",
                          status: "active",
                          refresh_token: "must stay local",
                        },
                      ],
                    }
                  : { data: catalog },
              ),
            ),
          );
        });
        const service = InferenceProxy.layer.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
          Layer.provide(
            Layer.mock(DirectEndpoints)({
              resolveAvailable: () =>
                Effect.succeed(
                  lan ? [{ kind: "lan", httpBaseUrl: "http://192.168.1.12:12345/" }] : [],
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.sync(() => identity),
            }),
          ),
          Layer.provide(Layer.succeed(ServerConfig.ServerConfig, { ...config, port: 12345 })),
          Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({})),
          Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
          Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
          Layer.provide(Layer.succeed(HostProcess.Architecture, "arm64")),
          Layer.provide(NetService.layer),
          Layer.fresh,
        );
        const settings = yield* ServerSettings.ServerSettingsService;
        const grant = yield* Effect.scoped(
          Effect.gen(function* () {
            const proxy = yield* InferenceProxy.InferenceProxy;
            expect((yield* proxy.status).enabled).toBe(false);
            const startSharing = proxy.manage({
              operation: "configure",
              enabled: true,
              sharing: true,
            });
            expect((yield* startSharing.pipe(Effect.flip)).message).toContain("Tailscale HTTPS");
            expect((yield* proxy.status).enabled).toBe(false);
            lan = true;
            yield* startSharing;
            expect((yield* proxy.grant(peer)).baseUrl).toBe(
              "http://192.168.1.12:12345/api/inference",
            );
            serving = true;
            yield* startSharing;
            const { accounts } = yield* proxy.status;
            expect(accounts).toEqual([{ name: "one.json", provider: "codex", status: "active" }]);
            catalog = [{ id: "bridge/coding" }];
            const mapping = { source: "traex", pool: "work", upstream: "bridge/coding" } as const;
            expect(
              (yield* proxy.manage({ operation: "mapModel", mapping }).pipe(Effect.flip)).message,
            ).toContain("Traex bridge");
            yield* fs.makeDirectory(home + "/.traex-bridge");
            yield* fs.writeFileString(home + "/.traex-bridge/api-key", "bridge-fixture");
            expect(
              (yield* proxy.manage({ operation: "listModels", source: "traex" })).models,
            ).toEqual(["bridge/coding"]);
            catalog = [];
            yield* proxy.manage({ operation: "mapModel", mapping });
            yield* proxy.manage({
              operation: "mapModel",
              mapping: { ...mapping, upstream: "renamed" },
            });
            yield* proxy.manage({
              operation: "mapModel",
              mapping: { ...mapping, source: "codex", upstream: "gpt-native" },
            });
            yield* proxy.manage({
              operation: "mapModel",
              mapping: { ...mapping, source: "claudeAgent", upstream: "claude-native" },
            });
            yield* proxy.manage({ operation: "setRouting", strategy: "fill-first" });
            yield* proxy.manage({ operation: "setRouting", sessionAffinity: false });
            const safeStatus = yield* proxy.status;
            expect(JSON.stringify(safeStatus)).not.toContain("bridge-fixture");
            expect(safeStatus.routing?.mappings).toHaveLength(3);
            const readConfig = fs
              .readFileString(config.stateDir + "/inference-proxy/config.yaml")
              .pipe(Effect.map((s) => JSON.parse(s) as Record<string, unknown>));
            expect(yield* readConfig).toMatchObject({
              routing: { strategy: "fill-first", "session-affinity": false },
              oauth: {
                "model-alias": {
                  codex: [{ name: "gpt-native", alias: "codex-pool-work", fork: true }],
                  claude: [{ name: "claude-native", alias: "claude-pool-work", fork: true }],
                },
              },
              "api-keys": {
                codex: [
                  {
                    "base-url": "http://127.0.0.1:8317/v1",
                    keys: [{ "api-key": "bridge-fixture" }],
                    models: [{ name: "renamed", alias: "codex-pool-work" }],
                  },
                ],
              },
            });
            yield* proxy.manage({ operation: "unmapModel", source: "traex", pool: "work" });
            expect(yield* readConfig).not.toHaveProperty("api-keys");
            const issued = yield* proxy.grant(peer);
            expect(issued.baseUrl).toBe("https://pool.example.ts.net/api/inference");
            expect((yield* proxy.grant(peer)).key).toBe(issued.key);
            expect((yield* proxy.authorize(issued.key))?.key).not.toBe(issued.key);
            const local = yield* proxy.grant({ environmentId: hostId, label: "Host" });
            const connect = { grant: local, driver: "codex" as const, hostLabel: "Host" };
            expect(yield* proxy.connect(connect).pipe(Effect.flip)).toHaveProperty(
              "_tag",
              "InferenceProxyError",
            );
            catalog = [
              { id: "codex-auto-review", owned_by: "openai" },
              { id: "office-model", owned_by: "openai" },
              { id: "gpt-other", owned_by: "anthropic" },
              { id: "gpt-fixture" },
            ];
            expect(
              (yield* proxy
                .connect({ ...connect, grant: { ...local, key: "expired-local-key" } })
                .pipe(Effect.flip)).message,
            ).toContain("local inference");
            yield* proxy.connect(connect);
            expect(
              Object.values((yield* settings.getSettings).providerInstances).find(
                (i) => i.displayName === "Codex via Host",
              )?.config,
            ).toMatchObject({ customModels: ["codex-auto-review", "office-model", "gpt-fixture"] });
            const firstRoute = (yield* proxy.status).routes[0]?.instanceId;
            expect(firstRoute).toMatch(/^inference_codex_/);
            expect(Object.values((yield* settings.getSettings).providerInstances)).toEqual(
              expect.arrayContaining([expect.objectContaining({ displayName: "Codex via Host" })]),
            );
            expect(
              yield* proxy.connect({ ...connect, grant: issued }).pipe(Effect.flip),
            ).toHaveProperty("_tag", "InferenceProxyError");
            identity = peer.environmentId;
            peerId = peer.environmentId;
            expect(
              (yield* proxy.connect({ ...connect, grant: issued }).pipe(Effect.flip)).message,
            ).toContain("another T3 environment");
            expect(remoteCatalogKeys).toEqual([]);
            peerId = hostId;
            yield* proxy.connect({ ...connect, grant: issued });
            expect(remoteCatalogKeys).toEqual(["Bearer " + issued.key]);
            tailnetCatalogDown = true;
            yield* proxy.connect({ ...connect, grant: issued });
            expect(
              Object.values((yield* settings.getSettings).providerInstances).find(
                (i) => i.displayName === "Codex via Host",
              )?.config,
            ).toMatchObject({ launchArgs: expect.stringContaining("192.168.1.12") });
            tailnetCatalogDown = false;
            const routes = (yield* proxy.status).routes;
            expect(routes).toHaveLength(1);
            peerId = EnvironmentId.make("other-host");
            yield* proxy.connect({
              ...connect,
              hostLabel: "Second",
              grant: { ...issued, hostId: peerId },
            });
            expect((yield* proxy.status).routes).toHaveLength(2);
            yield* proxy.manage({ operation: "removeRoute", instanceId: routes[0]!.instanceId });
            expect((yield* proxy.status).routes.map((r) => r.label)).toEqual(["Codex via Second"]);
            expect(
              yield* proxy
                .manage({ operation: "removeRoute", instanceId: ProviderInstanceId.make("codex") })
                .pipe(Effect.flip),
            ).toHaveProperty("_tag", "InferenceProxyError");
            identity = hostId;
            yield* proxy.manage({ operation: "checkUpdate" }).pipe(Effect.flip);
            registryOffline = false;
            expect((yield* proxy.manage({ operation: "checkUpdate" })).update).toEqual({
              current: proxyVersion,
              available: "8.0.61",
            });
            const update = yield* proxy
              .manage({ operation: "update" })
              .pipe(Effect.flip, Effect.forkScoped);
            yield* Deferred.await(downloading);
            expect((yield* proxy.authorize(issued.key))?.key).toBeDefined();
            yield* Deferred.succeed(finishDownload, undefined);
            expect((yield* Fiber.join(update)).message).toContain("checksum");
            expect((yield* proxy.status).version).toBe(proxyVersion);
            expect(stops).toBe(0);
            const staleRuntime = runtime.replace(proxyVersion, "8.0.58");
            const otherPlatform = staleRuntime.replace("darwin-arm64", "linux-x64");
            yield* fs.makeDirectory(staleRuntime);
            yield* fs.makeDirectory(otherPlatform);
            const installed = runtime.replace(proxyVersion, "8.0.61");
            yield* fs.makeDirectory(installed, { recursive: true });
            yield* fs.writeFileString(installed + "/cli-proxy-api", "");
            rejectNextLaunch = true;
            yield* proxy.manage({ operation: "update" }).pipe(Effect.flip);
            expect(yield* proxy.status).toMatchObject({ running: true, version: proxyVersion });
            expect((yield* proxy.authorize(issued.key))?.key).toBeDefined();
            yield* proxy.manage({ operation: "update" });
            expect((yield* proxy.status).version).toBe("8.0.61");
            expect(yield* fs.exists(staleRuntime)).toBe(false);
            expect(yield* fs.exists(otherPlatform)).toBe(true);
            expect(yield* fs.exists(runtime)).toBe(true);
            return issued;
          }).pipe(Effect.provide(service)),
        );
        expect(stops).toBe(3);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const proxy = yield* InferenceProxy.InferenceProxy;
            expect((yield* proxy.status).routing).toMatchObject({
              strategy: "fill-first",
              sessionAffinity: false,
              mappings: [
                { source: "codex", pool: "work" },
                { source: "claudeAgent", pool: "work" },
              ],
            });
            expect((yield* proxy.authorize(grant.key))?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
            yield* proxy.manage({ operation: "revoke", environmentId: peer.environmentId });
            expect(yield* proxy.authorize(grant.key)).toBeNull();
            expect((yield* proxy.grant(peer)).key).not.toBe(grant.key);
            expectRecovery = true;
            yield* Deferred.succeed(currentExit!, undefined);
            yield* TestClock.adjust("1 second");
            yield* Deferred.await(recovered);
            yield* proxy.manage({ operation: "configure", enabled: false, sharing: false });
            expect((yield* proxy.status).consumers).toEqual([]);
            expect(Option.isSome(yield* state.get("inference-proxy-state"))).toBe(true);
          }).pipe(Effect.provide(service)),
        );
        expect(starts).toBe(5);
        expect(stops).toBe(5);
      }).pipe(
        Effect.provide(
          Layer.merge(ServerSettings.layerTest(), ServerSecretStore.layer).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-inference-test-" }),
            ),
            Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
    ),
);
