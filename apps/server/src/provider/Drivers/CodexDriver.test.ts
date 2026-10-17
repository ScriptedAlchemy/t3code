import * as CodexInstallation from "../CodexInstallation.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ModelManifest from "../ModelManifest.ts";
import {
  createProviderVersionAdvisory,
  resolveLatestProviderVersion,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { CodexDriver } from "./CodexDriver.ts";
import { codexCliFixtureSource } from "../CodexCliAuth.testkit.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderCredentialStore from "../ProviderCredentialStore.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-codex-driver-maintenance-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.mock(CodexAdapterV2.CodexAppServerClientFactory)({
      open: () => Effect.die("Maintenance resolution must not open a Codex session"),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(CodexInstallation.CodexInstallation)({
      managedDirectory: "unused-managed-installation",
    }),
  ),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
    }),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Codex must not make an HTTP request")),
    ),
  ),
);
const layerTest = ProviderHostLive.layer.pipe(Layer.provideMerge(layerDeps));

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Codex must not spawn a process"),
);
const encodeCredentials = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.layer(layerTest)("CodexDriver", (it) => {
  it.effect.skipIf(windowsHost)(
    "guards native account consumers and refreshes after cancellation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-cli-driver-" });
        const binaryPath = NodePath.join(root, "codex");
        const sharedHome = NodePath.join(root, "shared");
        const ignoredShadow = NodePath.join(root, "user-shadow");
        const instanceId = ProviderInstanceId.make("codex-cli-driver");
        const ownedHome = NodePath.join(config.stateDir, "providers", "codex", instanceId, "cli");
        const source = codexCliFixtureSource
          .replace(
            'if (method === "account/login/start") {',
            'if (method === "account/login/start") { fs.writeFileSync(path.join(home, "login-started"), "yes");',
          )
          .replace(
            'if (method === "account/read") return',
            'if (method === "account/read" && !fs.existsSync(path.join(home, "login-started"))) return; if (method === "account/read") return',
          );
        yield* fs.writeFileString(binaryPath, `#!${process.execPath}\n${source}`, { mode: 0o755 });
        const firstSpawn = yield* Deferred.make<void>();
        const children: Array<ChildProcessSpawner.ChildProcessHandle> = [];
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const instance = yield* CodexDriver.create({
          instanceId,
          displayName: "Native account",
          enabled: true,
          environment: [{ name: "T3_TEST_MODE", value: "waiting", sensitive: false }],
          config: {
            ...CodexDriver.defaultConfig(),
            setupMode: "cli",
            binaryPath,
            homePath: sharedHome,
            shadowHomePath: ignoredShadow,
          },
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              Effect.gen(function* () {
                const child = yield* spawner.spawn(command);
                children.push(child);
                yield* Deferred.succeed(firstSpawn, undefined);
                return child;
              }),
            ),
          ),
        );
        expect(instance.auth?.credentialBinding).toEqual({ owner: "provider", key: ownedHome });
        const checking = yield* instance.snapshot.refresh.pipe(Effect.forkScoped);
        yield* Deferred.await(firstSpawn);
        yield* instance.auth!.start("owner");
        const waiting = yield* instance.auth!.subscribe("owner").pipe(
          Stream.filter((state) => state.phase === "waiting"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect((yield* Fiber.join(checking)).auth.status).toBe("unknown");
        expect(yield* children[0]!.isRunning).toBe(false);
        const beforeBlockedCalls = children.length;
        expect((yield* instance.snapshot.refresh).auth.status).toBe("unknown");
        expect(
          yield* instance.snapshotForCwd!(root).pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
        ).toBe("ProviderDriverError");
        expect(
          yield* instance.consumeResetCredit!().pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
        ).toBe("ProviderDriverError");
        expect(
          yield* instance.textGeneration
            .generateThreadTitle({
              cwd: root,
              message: "Title",
              modelSelection: { instanceId, model: "gpt-5.4" },
            })
            .pipe(
              Effect.flip,
              Effect.map((error) => error._tag),
            ),
        ).toBe("TextGenerationError");
        expect(children.length).toBe(beforeBlockedCalls);
        const automaticRefresh = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((value) => value.installed && value.auth.status === "unauthenticated"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.forkScoped,
        );
        yield* instance.auth!.cancel("owner", waiting.flowId!);
        const refreshed = yield* Fiber.join(automaticRefresh);
        expect(refreshed).toMatchObject({
          installed: true,
          auth: { status: "unauthenticated" },
          setup: { canAuthenticate: true },
          runtimePaths: { homePath: sharedHome, shadowHomePath: ownedHome },
        });
        expect(yield* fs.exists(ignoredShadow)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["path", "managed"] as const)(
    "reports the selected native executable from %s in runtime paths",
    (source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-native-executable-" });
        const binDir = NodePath.join(root, "instance-bin");
        yield* fs.makeDirectory(binDir);
        const executablePath = NodePath.join(source === "path" ? binDir : root, "codex");
        yield* fs.writeFileString(
          executablePath,
          `#!${process.execPath}\n${codexCliFixtureSource}`,
          { mode: 0o755 },
        );
        const installation = yield* CodexInstallation.CodexInstallation;
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make(`native-executable-${source}`),
          displayName: "Native executable",
          enabled: true,
          environment: [{ name: "PATH", value: binDir, sensitive: false }],
          config: {
            ...CodexDriver.defaultConfig(),
            setupMode: "cli",
            homePath: NodePath.join(root, "shared"),
          },
        }).pipe(
          Effect.provideService(CodexInstallation.CodexInstallation, {
            ...installation,
            acquire: () =>
              Effect.succeed({
                executablePath,
                managedVersionDirectory: root,
                source: "managed" as const,
                version: "0.156.1",
              }),
          }),
        );
        expect(yield* instance.snapshot.refresh).toMatchObject({
          installed: true,
          runtimePaths: { binaryPath: executablePath },
        });
      }),
    { skip: windowsHost },
  );

  it.effect.each(["host", "instance"] as const)(
    "shares the %s CODEX_HOME with native account runtime and usage",
    (source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-custom-home-" });
        const sharedHome = NodePath.join(root, "shared");
        yield* fs.makeDirectory(sharedHome);
        yield* fs.writeFileString(NodePath.join(sharedHome, "config.toml"), 'model = "gpt-5.4"\n');
        const instanceId = ProviderInstanceId.make(`custom-home-${source}`);
        const ownedHome = NodePath.join(
          serverConfig.stateDir,
          "providers",
          "codex",
          instanceId,
          "cli",
        );
        const config = {
          ...CodexDriver.defaultConfig(),
          setupMode: "cli" as const,
          shadowHomePath: NodePath.join(root, "ignored"),
        };
        const instance = yield* CodexDriver.create({
          instanceId,
          displayName: "Custom shared home",
          enabled: false,
          environment:
            source === "instance"
              ? [{ name: "CODEX_HOME", value: sharedHome, sensitive: false }]
              : [],
          config,
        }).pipe(
          Effect.provideService(HostProcess.HomeDirectory, root),
          Effect.provideService(
            HostProcess.Environment,
            source === "host" ? { CODEX_HOME: sharedHome } : {},
          ),
        );
        expect(instance.auth?.credentialBinding).toEqual({ owner: "provider", key: ownedHome });
        expect((yield* instance.snapshot.getSnapshot).runtimePaths).toMatchObject({
          homePath: sharedHome,
          shadowHomePath: ownedHome,
        });
        expect(yield* fs.readLink(NodePath.join(ownedHome, "sessions"))).toBe(
          NodePath.join(sharedHome, "sessions"),
        );
        expect(yield* fs.readFileString(NodePath.join(ownedHome, "config.toml"))).toBe(
          'model = "gpt-5.4"\n',
        );
        if (CodexDriver.usage?.kind !== "transcripts") throw new Error("Expected transcript usage");
        expect(
          yield* CodexDriver.usage.directories({
            instanceId,
            config,
            environment: { CODEX_HOME: sharedHome },
            configured: true,
          }),
        ).toEqual([{ dir: NodePath.join(sharedHome, "sessions") }]);
      }),
  );

  it.effect.each([true, false])(
    "keeps the instance PATH boundary when host Codex exists and managed installation is %s",
    (managedInstalled) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-instance-path-" });
        const hostBin = NodePath.join(root, "host-bin");
        const instanceBin = NodePath.join(root, "instance-bin");
        yield* fs.makeDirectory(hostBin);
        yield* fs.makeDirectory(instanceBin);
        const hostBinary = NodePath.join(hostBin, "codex");
        yield* fs.writeFileString(hostBinary, "#!/bin/sh\nprintf 'codex-cli 0.156.2\\n'\n", {
          mode: 0o755,
        });
        const managedDirectory = NodePath.join(root, "tools", "codex");
        const versionDirectory = NodePath.join(managedDirectory, "0.156.1");
        const managedBinary = NodePath.join(versionDirectory, "bin", "codex");
        if (managedInstalled) {
          for (const relative of ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg"]) {
            const file = NodePath.join(versionDirectory, relative);
            yield* fs.makeDirectory(NodePath.dirname(file), { recursive: true });
            yield* fs.writeFileString(file, "#!/bin/sh\n", { mode: 0o755 });
          }
          yield* fs.writeFileString(
            NodePath.join(versionDirectory, "codex-package.json"),
            JSON.stringify({
              layoutVersion: 1,
              version: "0.156.1",
              target: "test-target",
              entrypoint: "bin/codex",
            }),
          );
          yield* fs.writeFileString(
            NodePath.join(versionDirectory, ".install-complete.json"),
            JSON.stringify({ version: "0.156.1", target: "test-target", sha256: "test-sha" }),
          );
          yield* fs.writeFileString(
            NodePath.join(managedDirectory, "active.json"),
            '{"version":"0.156.1"}',
          );
        }
        const installation = yield* CodexInstallation.makeCodexInstallation({ baseDir: root }).pipe(
          Effect.provideService(HostProcess.Environment, { PATH: hostBin }),
        );
        expect(yield* installation.acquire().pipe(Effect.scoped)).toMatchObject({
          source: "local",
          executablePath: hostBinary,
        });
        const commands: Array<string> = [];
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("isolated-path"),
          displayName: "Instance PATH",
          enabled: true,
          environment: [{ name: "PATH", value: instanceBin, sensitive: false }],
          config: { ...CodexDriver.defaultConfig(), homePath: NodePath.join(root, "home") },
        }).pipe(
          Effect.provideService(CodexInstallation.CodexInstallation, installation),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              if (ChildProcess.isStandardCommand(command)) commands.push(command.command);
              return Effect.fail(
                PlatformError.badArgument({
                  module: "ChildProcessSpawner",
                  method: "spawn",
                  description: "Fixture records the selected executable",
                }),
              );
            }),
          ),
        );
        const snapshot = yield* instance.snapshot.refresh;
        expect(snapshot.installed).toBe(false);
        expect(snapshot.status).toBe("error");
        expect([...new Set(commands)]).toEqual([managedInstalled ? managedBinary : "codex"]);
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "uses a later installation without recreating an existing instance and leases only active operations",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-later-install-" });
        const binDir = NodePath.join(root, "bin");
        yield* fs.makeDirectory(binDir);
        const managedDirectory = NodePath.join(root, "tools", "codex");
        const executablePath = NodePath.join(managedDirectory, "0.156.1", "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(executablePath), { recursive: true });
        yield* fs.writeFileString(
          executablePath,
          [
            `#!${process.execPath}`,
            'const fs = require("node:fs");',
            "const args = process.argv.slice(2);",
            'if (args.includes("mcp")) { process.stdout.write("[]"); process.exit(0); }',
            'if (args.includes("exec")) {',
            '  fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ title: "Installed runtime title" }));',
            '  process.stdin.resume(); process.stdin.on("end", () => process.exit(0));',
            "} else {",
            '  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
            "    const { id, method } = JSON.parse(line);",
            "    if (id === undefined) return;",
            "    const results = {",
            '      initialize: { userAgent: "codex/0.156.1", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" },',
            '      "account/read": { account: { type: "apiKey" }, requiresOpenaiAuth: false },',
            '      "model/list": { data: [], nextCursor: null },',
            '      "skills/list": { data: [] },',
            '      "account/rateLimits/read": { rateLimits: {} },',
            '      "account/rateLimitResetCredit/consume": { outcome: "nothingToReset" },',
            "    };",
            '    process.stdout.write(JSON.stringify({ id, result: results[method] }) + "\\n");',
            "  });",
            "}",
          ].join("\n"),
        );
        yield* fs.chmod(executablePath, 0o755);
        const installation = yield* CodexInstallation.CodexInstallation;
        let available = false;
        let leases = 0;
        let idle = Deferred.makeUnsafe<void>();
        yield* Deferred.succeed(idle, undefined);
        const instanceId = ProviderInstanceId.make("later-install");
        const instance = yield* CodexDriver.create({
          instanceId,
          displayName: "Existing custom provider",
          enabled: true,
          environment: [{ name: "PATH", value: binDir, sensitive: false }],
          config: {
            ...CodexDriver.defaultConfig(),
            homePath: NodePath.join(root, "home"),
            launchArgs: '-c model_provider="traex"',
          },
        }).pipe(
          Effect.provide(CodexAdapterV2.layerAppServerClientFactory),
          Effect.provideService(CodexInstallation.CodexInstallation, {
            ...installation,
            managedDirectory,
            acquire: (options) =>
              Effect.gen(function* () {
                expect(options).toEqual({ managedOnly: true });
                if (!available)
                  return yield* new CodexInstallation.CodexInstallationError({
                    operation: "resolve",
                    detail: "No Codex installation is available.",
                  });
                return yield* Effect.acquireRelease(
                  Effect.sync(() => {
                    if (leases === 0) idle = Deferred.makeUnsafe<void>();
                    leases += 1;
                    return {
                      executablePath,
                      managedVersionDirectory: root,
                      source: "managed" as const,
                      version: "0.156.1",
                    };
                  }),
                  () =>
                    Effect.sync(() => {
                      leases -= 1;
                    }).pipe(
                      Effect.flatMap(() =>
                        leases === 0 ? Deferred.succeed(idle, undefined) : Effect.void,
                      ),
                    ),
                );
              }),
          }),
        );
        expect((yield* instance.snapshot.refresh).installed).toBe(false);
        expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
        expect(leases).toBe(0);

        available = true;
        const snapshot = yield* instance.snapshot.refresh;
        expect(snapshot).toMatchObject({ installed: true, status: "ready", version: "0.156.1" });
        expect(leases).toBe(0);
        const maintenance = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        expect(maintenance.update).toBeNull();
        expect(yield* resolveLatestProviderVersion(maintenance)).toBeNull();
        yield* Deferred.await(idle);
        expect(leases).toBe(0);
        const title = yield* instance.textGeneration.generateThreadTitle({
          cwd: root,
          message: "Use the new installation",
          modelSelection: { instanceId, model: "gpt-5.4" },
        });
        expect(title).toEqual({ title: "Installed runtime title" });
        expect(leases).toBe(0);
        expect((yield* instance.snapshotForCwd!(root)).installed).toBe(true);
        expect(leases).toBe(0);
        expect(yield* instance.consumeResetCredit!()).toBe("nothingToReset");
        expect(leases).toBe(0);
        yield* Effect.gen(function* () {
          const session = yield* instance.orchestrationAdapter.openSession({
            threadId: ThreadId.make("later-install-thread"),
            providerSessionId: ProviderSessionId.make("later-install-session"),
            modelSelection: { instanceId, model: "gpt-5.4" },
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: root,
            }),
          });
          expect(session.providerSession.providerInstanceId).toBe(instanceId);
          expect(leases).toBe(1);
        }).pipe(Effect.scoped);
        expect(leases).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "missing default command",
      binaryPath: "codex",
      onPath: false,
      available: true,
      enabled: true,
      acquires: 1,
    },
    {
      name: "empty default command",
      binaryPath: "",
      onPath: false,
      available: true,
      enabled: true,
      acquires: 1,
    },
    {
      name: "PATH command",
      binaryPath: "codex",
      onPath: true,
      available: true,
      enabled: true,
      acquires: 0,
    },
    {
      name: "explicit path",
      binaryPath: "/custom/bin/codex",
      onPath: false,
      available: true,
      enabled: true,
      acquires: 0,
    },
    {
      name: "explicit command",
      binaryPath: "custom-codex",
      onPath: false,
      available: true,
      enabled: true,
      acquires: 0,
    },
    {
      name: "unavailable installation",
      binaryPath: "codex",
      onPath: false,
      available: false,
      enabled: true,
      acquires: 1,
    },
    {
      name: "disabled provider",
      binaryPath: "codex",
      onPath: false,
      available: true,
      enabled: false,
      acquires: 0,
    },
  ])(
    "resolves an existing-mode executable for $name",
    (fixture) =>
      Effect.gen(function* () {
        let acquisitions = 0;
        let leases = 0;
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-existing-" });
          const binDir = NodePath.join(root, "bin");
          yield* fs.makeDirectory(binDir);
          if (fixture.onPath) {
            const command = NodePath.join(binDir, windowsHost ? "codex.exe" : "codex");
            yield* fs.writeFileString(command, "#!/bin/sh\n");
            yield* fs.chmod(command, 0o755);
          }
          const acquiredPath = NodePath.join(root, "installed", "codex");
          const installation = yield* CodexInstallation.CodexInstallation;
          const launches: Array<
            Parameters<CodexAdapterV2.CodexAppServerClientFactoryShape["open"]>[0]
          > = [];
          const commands: Array<ChildProcess.StandardCommand> = [];
          const homePath = NodePath.join(root, "shared");
          const shadowHomePath = NodePath.join(root, "shadow");
          const launchArgs = '-c model_provider="traex"';
          const instanceId = ProviderInstanceId.make("existing-runtime");
          const instance = yield* CodexDriver.create({
            instanceId,
            displayName: "Existing runtime",
            enabled: fixture.enabled,
            environment: [
              { name: "PATH", value: binDir, sensitive: false },
              { name: "TRAEX_TOKEN", value: "custom-token", sensitive: true },
            ],
            config: {
              ...CodexDriver.defaultConfig(),
              binaryPath: fixture.binaryPath,
              homePath,
              shadowHomePath,
              launchArgs,
            },
          }).pipe(
            Effect.provideService(CodexInstallation.CodexInstallation, {
              ...installation,
              acquire: (options) =>
                Effect.gen(function* () {
                  expect(options).toEqual({ managedOnly: true });
                  acquisitions += 1;
                  if (!fixture.available)
                    return yield* new CodexInstallation.CodexInstallationError({
                      operation: "resolve",
                      detail: "No Codex installation is available.",
                    });
                  return yield* Effect.acquireRelease(
                    Effect.sync(() => {
                      leases += 1;
                      return {
                        executablePath: acquiredPath,
                        managedVersionDirectory: root,
                        source: "managed" as const,
                        version: "0.156.1",
                      };
                    }),
                    () =>
                      Effect.sync(() => {
                        leases -= 1;
                      }),
                  );
                }),
            }),
            Effect.provideService(CodexAdapterV2.CodexAppServerClientFactory, {
              open: (launch) =>
                Effect.sync(() => launches.push(launch)).pipe(
                  Effect.andThen(Effect.die("Fixture records the requested session launch")),
                ),
            }),
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((command) => {
                if (ChildProcess.isStandardCommand(command)) commands.push(command);
                return Effect.fail(
                  PlatformError.badArgument({
                    module: "ChildProcessSpawner",
                    method: "spawn",
                    description: "Fixture records the requested command",
                  }),
                );
              }),
            ),
          );
          yield* instance.snapshot.refresh;
          expect(leases).toBe(0);
          if (!fixture.enabled) {
            expect((yield* instance.snapshot.getSnapshot).enabled).toBe(false);
            expect(commands).toEqual([]);
            return;
          }
          const expectedBinary =
            fixture.acquires && fixture.available ? acquiredPath : fixture.binaryPath || "codex";
          const beforeSession = acquisitions;
          yield* instance.orchestrationAdapter
            .openSession({
              threadId: ThreadId.make("existing-thread"),
              providerSessionId: ProviderSessionId.make("existing-session"),
              modelSelection: { instanceId, model: "gpt-5.4" },
              runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: root,
              }),
            })
            .pipe(Effect.scoped, Effect.exit);
          expect(launches).toHaveLength(1);
          expect(launches[0]).toMatchObject({
            settings: { binaryPath: expectedBinary, homePath: shadowHomePath, launchArgs },
            environment: { TRAEX_TOKEN: "custom-token", PATH: binDir },
          });
          expect(acquisitions - beforeSession).toBe(fixture.acquires);
          expect(leases).toBe(0);
          const beforeRefresh = acquisitions;
          const snapshot = yield* instance.snapshot.refresh;
          expect(snapshot.installed).toBe(false);
          expect(acquisitions - beforeRefresh).toBe(fixture.acquires);
          expect(leases).toBe(0);
          yield* instance.textGeneration
            .generateThreadTitle({
              cwd: root,
              message: "Add a test",
              modelSelection: { instanceId, model: "gpt-5.4" },
            })
            .pipe(Effect.exit);
          expect(commands.at(-1)?.args).toContain("exec");
          expect(commands.map((command) => command.command)).toEqual(
            commands.map(() => expectedBinary),
          );
          expect(commands.at(-1)?.options.env).toMatchObject({
            CODEX_HOME: shadowHomePath,
            TRAEX_TOKEN: "custom-token",
          });
          expect(leases).toBe(0);
        }).pipe(Effect.scoped);
        expect(leases).toBe(0);
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect("disconnect refreshes a restored managed account while its auth flow is idle", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("restored-managed-account");
      const credentials = new Map<string, Uint8Array>();
      const secrets = ServerSecretStore.ServerSecretStore.of({
        get: (key) => Effect.sync(() => Option.fromUndefinedOr(credentials.get(key))),
        set: (key, value) =>
          Effect.sync(() => {
            credentials.set(key, value);
          }),
        remove: (key) =>
          Effect.sync(() => {
            credentials.delete(key);
          }),
        create: () => Effect.die("unused"),
        getOrCreateRandom: () => Effect.die("unused"),
      });
      yield* Effect.gen(function* () {
        const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
        const json = yield* encodeCredentials({
          clientId: "oaiapp_test",
          accessToken: "dummy-owned-access",
          refreshToken: "dummy-refresh",
          expiresAt: Number.MAX_SAFE_INTEGER,
          earliestRefreshAt: null,
          scopes: ["chatgpt.tokens.use.direct"],
          subject: "test-user",
          email: "account@example.test",
        });
        yield* store.set(new TextEncoder().encode(json));
        const executable = {
          executablePath: "/user/bin/codex",
          managedVersionDirectory: null,
          source: "local" as const,
          version: "0.156.1",
        };
        const installation = yield* CodexInstallation.CodexInstallation;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const sharedHome = NodePath.join(serverConfig.stateDir, "shared-codex-home");
        const launches: Array<
          Parameters<CodexAdapterV2.CodexAppServerClientFactoryShape["open"]>[0]
        > = [];

        let interruptedChecks = 0;
        const startupChecksInterrupted = yield* Deferred.make<void>();
        const acquire = () =>
          Effect.suspend(() => {
            if (interruptedChecks === 2) return Effect.succeed(executable);
            interruptedChecks += 1;
            return (
              interruptedChecks === 2
                ? Deferred.succeed(startupChecksInterrupted, undefined)
                : Effect.void
            ).pipe(Effect.andThen(Effect.interrupt));
          });
        const instance = yield* CodexDriver.create({
          instanceId,
          displayName: "Restored account",
          enabled: true,
          environment: [{ name: "OPENAI_API_KEY", value: "ambient-key", sensitive: true }],
          config: { ...CodexDriver.defaultConfig(), setupMode: "managed", homePath: sharedHome },
        }).pipe(
          Effect.provideService(
            CodexAdapterV2.CodexAppServerClientFactory,
            CodexAdapterV2.CodexAppServerClientFactory.of({
              open: (launch) =>
                Effect.sync(() => launches.push(launch)).pipe(
                  Effect.andThen(Effect.die("The fixture stops after recording the launch")),
                ),
            }),
          ),
          Effect.provideService(
            CodexInstallation.CodexInstallation,
            CodexInstallation.CodexInstallation.of({
              ...installation,
              managedDirectory: "unused-managed-installation",
              resolve: () => Effect.succeed(executable),
              acquire,
            }),
          ),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.fail(
                PlatformError.badArgument({
                  module: "ChildProcessSpawner",
                  method: "spawn",
                  description: "The fixture app-server is unavailable",
                }),
              ),
            ),
          ),
        );
        const observedAccount = yield* Deferred.make<void>();
        const disconnected = yield* instance.snapshot.streamChanges.pipe(
          Stream.tap((provider) =>
            provider.auth.status === "authenticated"
              ? Deferred.succeed(observedAccount, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Stream.filter((provider) => provider.auth.status === "unauthenticated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* Deferred.await(startupChecksInterrupted);
        const restored = yield* instance.snapshot.refresh;
        expect(restored.auth.email).toBe("account@example.test");
        expect(restored.runtimePaths?.homePath).toBe(sharedHome);
        expect(restored.runtimePaths?.shadowHomePath).toContain(
          `providers/codex/${instanceId}/shadow`,
        );
        yield* Deferred.await(observedAccount);

        const threadId = ThreadId.make("managed-account-thread");
        yield* instance.orchestrationAdapter
          .openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("managed-account-session"),
            modelSelection: { instanceId, model: "gpt-5.4" },
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: serverConfig.stateDir,
            }),
          })
          .pipe(Effect.scoped, Effect.exit);
        expect(launches).toHaveLength(1);
        const launch = launches[0]!;
        expect(launch.settings.binaryPath).toBe(executable.executablePath);
        expect(launch.settings.launchArgs).toContain("openai_token_sharing");
        expect(launch.environment.ACCESS_TOKEN).toBe("dummy-owned-access");
        expect(launch.environment.OPENAI_API_KEY).toBeUndefined();
        expect(launch.environment.CODEX_HOME).toBe(launch.settings.homePath);
        const before = yield* instance.auth!.subscribe("test-owner").pipe(Stream.runHead);
        expect(Option.getOrThrow(before).phase).toBe("idle");
        yield* instance.auth!.logout(Effect.void);
        const after = Option.getOrThrow(yield* Fiber.join(disconnected));
        expect(after.auth.status).toBe("unauthenticated");
        expect(after.auth.email).toBeUndefined();
        expect(after.installed).toBe(true);
        expect(after.models).toEqual([]);
        expect(Option.isNone(yield* store.get)).toBe(true);
      }).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              expect([
                "https://auth.openai.com/.well-known/openid-configuration",
                "https://auth.openai.com/revoke",
                "https://api.openai.com/v1/models",
              ]).toContain(request.url);
              if (request.url.endsWith("/models"))
                return HttpClientResponse.fromWeb(request, Response.json({ models: [] }));
              return HttpClientResponse.fromWeb(
                request,
                request.url.endsWith("/revoke")
                  ? new Response(null, { status: 200 })
                  : Response.json({
                      issuer: "https://auth.openai.com",
                      authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
                      token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
                      jwks_uri: "https://auth.openai.com/jwks",
                      revocation_endpoint: "https://auth.openai.com/revoke",
                    }),
              );
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each(["direct", "symlink", "path", "neighbor"] as const)(
    "resolves maintenance for a %s reference to the managed installation",
    (reference) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-managed-update-" });
        const managedDirectory = NodePath.join(root, "tools", "codex");
        yield* fs.makeDirectory(managedDirectory, { recursive: true });
        const binary = NodePath.join(
          reference === "neighbor" ? `${managedDirectory}-external` : managedDirectory,
          "0.156.1",
          "bin",
          "codex",
        );
        yield* fs.makeDirectory(NodePath.dirname(binary), { recursive: true });
        yield* fs.writeFileString(binary, "#!/bin/sh\n", { mode: 0o755 });
        const link = NodePath.join(root, "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(link));
        yield* fs.symlink(binary, link);
        const installation = yield* CodexInstallation.CodexInstallation;
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-managed-update"),
          displayName: "Managed Codex",
          enabled: false,
          environment: [{ name: "PATH", value: NodePath.dirname(link), sensitive: false }],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath: reference === "path" ? "codex" : reference === "symlink" ? link : binary,
          },
        }).pipe(
          Effect.provideService(CodexInstallation.CodexInstallation, {
            ...installation,
            managedDirectory,
          }),
        );
        const maintenance = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        if (reference === "neighbor") {
          expect(maintenance.update).toMatchObject({ executable: binary, args: ["update"] });
        } else {
          expect(maintenance.update).toBeNull();
          expect(yield* resolveLatestProviderVersion(maintenance)).toBeNull();
        }
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "runs the standalone updater against the shared home, not the shadow home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-driver-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const sharedHome = NodePath.join(tempDir, "codex-home");
        const shadowHome = NodePath.join(tempDir, "codex-shadow");
        const binaryPath = NodePath.join(sharedHome, "packages", "standalone", "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
        yield* fs.chmod(binaryPath, 0o755);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-shadow"),
          displayName: "Codex test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          },
        });

        const capabilities = yield* instance.snapshot.resolveMaintenance();
        expect(capabilities.update).toMatchObject({
          executable: binaryPath,
          args: ["update"],
          lockKey: "codex-native",
          env: { CODEX_HOME: sharedHome },
        });
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const instance = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("codex-missing"),
        displayName: "Codex test",
        enabled: false,
        environment: [],
        config: {
          ...CodexDriver.defaultConfig(),
          binaryPath: NodePath.join(NodeOS.tmpdir(), "t3-codex-missing", "codex"),
        },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );

  for (const fixture of [
    {
      name: "leaves mise npm-backend installations manual-only",
      installSegments: ["mise", "installs", "npm-openai-codex", "0.110.0"],
      npmOwned: false,
    },
    {
      name: "leaves mise tool aliases backed by npm manual-only",
      installSegments: ["mise", "installs", "codex", "0.110.0"],
      npmOwned: false,
    },
    {
      name: "keeps npm updates for globals in a mise Node installation",
      installSegments: ["mise", "installs", "node", "24.0.0"],
      npmOwned: true,
    },
    {
      name: "keeps npm updates for ordinary global installations",
      installSegments: ["npm-global"],
      npmOwned: true,
    },
  ] as const) {
    it.effect.skipIf(windowsHost)(fixture.name, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-installer-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const installPath = NodePath.join(tempDir, ...fixture.installSegments);
        const realBinaryPath = NodePath.join(
          installPath,
          "lib",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        const binaryPath = NodePath.join(tempDir, "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(realBinaryPath), { recursive: true });
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(realBinaryPath, "#!/bin/sh\n");
        yield* fs.chmod(realBinaryPath, 0o755);
        yield* fs.symlink(realBinaryPath, binaryPath);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-installer"),
          displayName: "Codex installer test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        });

        const update = (yield* instance.snapshot.resolveMaintenance()).update;
        if (fixture.npmOwned) {
          expect(update).toMatchObject({
            executable: "npm",
            args: [
              "install",
              "-g",
              "--prefix",
              installPath,
              "--allow-scripts=@openai/codex",
              "@openai/codex@latest",
            ],
          });
        } else {
          expect(update).toBeNull();
        }
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
    );
  }

  for (const layout of ["direct", "wrapper"] as const) {
    it.effect.skipIf(windowsHost)(`leaves a mise ${layout} installation manual-only`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: `t3-codex-mise-${layout}-` })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const binaryPath =
          layout === "direct"
            ? NodePath.join(tempDir, "mise", "installs", "codex", "0.110.0", "codex")
            : NodePath.join(tempDir, "omarchy", "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(
          binaryPath,
          layout === "direct"
            ? "#!/bin/sh\n"
            : '#!/bin/sh\nmise use -g --quiet "codex" || exit 1\nexec mise x "codex" -- "codex" "$@"\n',
        );
        yield* fs.chmod(binaryPath, 0o755);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make(`codex-mise-${layout}`),
          displayName: "Codex mise test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        });

        expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
    );
  }

  it.effect.each([
    {
      name: "conventional shim",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "custom data directory",
      dataRoot: "custom-tool-data",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "renamed configured command",
      dataRoot: "mise",
      commandName: "custom-codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "outdated provider",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.3",
      nodeFirst: false,
    },
    {
      name: "npm before shim",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: true,
    },
  ])(
    "does not mistake Homebrew mise for Codex's installer: $name",
    (fixture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-mise-shim-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const brewPrefix = NodePath.join(tempDir, "homebrew");
        const brewPath = NodePath.join(brewPrefix, "bin", "brew");
        const misePath = NodePath.join(brewPrefix, "Cellar", "mise", "2026.9.1", "bin", "mise");
        const shimDir = NodePath.join(tempDir, fixture.dataRoot, "shims");
        const npmPrefix = NodePath.join(tempDir, "mise", "installs", "node", "24.13.0");
        const npmBin = NodePath.join(npmPrefix, "bin");
        const npmEntry = NodePath.join(
          npmPrefix,
          "lib",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        for (const file of [brewPath, misePath, npmEntry]) {
          yield* fs.makeDirectory(NodePath.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "#!/bin/sh\n");
          yield* fs.chmod(file, 0o755);
        }
        yield* fs.makeDirectory(shimDir, { recursive: true });
        yield* fs.makeDirectory(npmBin, { recursive: true });
        yield* fs.symlink(misePath, NodePath.join(shimDir, fixture.commandName));
        yield* fs.symlink(npmEntry, NodePath.join(npmBin, fixture.commandName));
        const lookupPath = [
          ...(fixture.nodeFirst ? [npmBin, shimDir] : [shimDir, npmBin]),
          NodePath.dirname(brewPath),
        ].join(NodePath.delimiter);
        const probes: Array<ReadonlyArray<string>> = [];
        const metadataSpawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command) || command.command !== brewPath) {
            return Effect.die("Provider resolution must not execute a provider or updater");
          }
          probes.push(command.args);
          const stdout =
            command.args[0] === "--prefix"
              ? brewPrefix
              : JSON.stringify({ formulae: [{ versions: { stable: "2026.9.1" } }] });
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(Stream.make(stdout)),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-mise-shim"),
          displayName: "Codex shim test",
          enabled: false,
          environment: [{ name: "PATH", value: lookupPath, sensitive: false }],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath: fixture.commandName,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, metadataSpawner));
        const capabilities = yield* instance.snapshot.resolveMaintenance();
        const latestVersion = yield* resolveLatestProviderVersion(capabilities).pipe(
          Effect.provideServiceEffect(
            ProviderLatestVersions.ProviderLatestVersions,
            ProviderLatestVersions.make([["@openai/codex", "0.153.4"]]),
          ),
        );
        expect(probes).toEqual([]);
        expect(latestVersion).toBe("0.153.4");
        expect(
          createProviderVersionAdvisory({
            driver: CodexDriver.driverKind,
            currentVersion: fixture.version,
            latestVersion,
            maintenanceCapabilities: capabilities,
          }),
        ).toMatchObject({
          status: fixture.version === "0.153.4" ? "current" : "behind_latest",
          currentVersion: fixture.version,
          latestVersion: "0.153.4",
          canUpdate: fixture.nodeFirst,
        });
        if (fixture.nodeFirst) {
          expect(capabilities.update).toMatchObject({
            executable: "npm",
            args: expect.arrayContaining([
              "--prefix",
              yield* fs.realPath(npmPrefix),
              "@openai/codex@latest",
            ]),
          });
        } else {
          expect(capabilities.update).toBeNull();
        }
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );
});
