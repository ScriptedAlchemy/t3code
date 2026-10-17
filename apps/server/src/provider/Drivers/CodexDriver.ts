import { CodexSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { CodexEffectiveRuntime } from "../CodexManagedRuntime.ts";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  createCodexAdapterV2,
  type CodexAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  probeCodexSkillsForCwd,
  withCodexAppServerClient,
} from "../CodexProvider.ts";
import { resolveCodexLaunchArgs } from "../codexLaunchArgs.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import { applyCodexModelCatalog } from "../codexModelCatalog.ts";
import type { ProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  codexContinuationIdentity,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { makeManagedCodexProvider } from "./CodexManagedProvider.ts";
import { codexUsageReader } from "./codexUsage.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DRIVER_KIND = ProviderDriverKind.make("codex");
function isCodexStandaloneCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/packages/standalone/");
}

/**
 * `codex update` replaces the standalone tree under `CODEX_HOME`. That tree
 * lives in the shared home even when an auth-overlay shadow home is in use
 * (the overlay only carries auth and a few local entries), so the updater
 * runs against `sharedHomePath` rather than the instance's effective home.
 */
function makeCodexMaintenanceResolver(
  sharedHomePath: string,
  managedDirectory: string,
): ProviderMaintenanceCapabilitiesResolver {
  const resolver = makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: "@openai/codex",
    nativeUpdate: {
      args: ["update"],
      isCommandPath: isCodexStandaloneCommandPath,
      env: { CODEX_HOME: sharedHomePath },
    },
  });
  return {
    resolve: (context) =>
      Effect.gen(function* () {
        if (context) {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const realManaged = yield* fs
            .realPath(managedDirectory)
            .pipe(Effect.orElseSucceed(() => managedDirectory));
          // T3 owns this versioned package; Codex's self-updater only handles its own installs.
          if (context.realCommandPath.startsWith(`${realManaged}${path.sep}`)) {
            return { provider: DRIVER_KIND, packageName: null, update: null };
          }
        }
        return yield* resolver.resolve(context);
      }),
  };
}

export type CodexDriverEnv =
  | CodexAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironmentIdentity
  | CodexInstallation.CodexInstallation;

export const CodexDriver: ProviderDriver<CodexSettings, CodexDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
  },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => decodeCodexSettings({}),
  usage: codexUsageReader,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      if (config.setupMode === "managed")
        return yield* makeManagedCodexProvider({
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config,
        });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const modelCatalog = yield* ModelCatalog.ModelCatalog;
      const currentCatalog = modelCatalog.current(DRIVER_KIND);
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const binaryPath =
        expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory) || "codex";
      const installation = yield* CodexInstallation.CodexInstallation;
      const homeLayout = yield* resolveCodexHomeLayout(config);
      const continuationIdentity = codexContinuationIdentity(homeLayout);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      yield* materializeCodexShadowHome(homeLayout).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause.message,
              cause,
            }),
        ),
      );
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath,
        homePath: homeLayout.effectiveHomePath ?? "",
      } satisfies CodexSettings;
      const resolveRuntime = Effect.gen(function* () {
        const executablePath =
          enabled &&
          binaryPath === "codex" &&
          !(yield* resolveCommandPath("codex", { env: processEnv }))
            ? yield* installation.acquire({ managedOnly: true }).pipe(
                Effect.map((executable) => executable.executablePath),
                Effect.catchTags({ CodexInstallationError: () => Effect.succeed(binaryPath) }),
              )
            : binaryPath;
        return {
          config: { ...effectiveConfig, binaryPath: executablePath },
          environment: processEnv,
          revision: executablePath,
        } satisfies CodexEffectiveRuntime;
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      );
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveRuntime.pipe(
          Effect.flatMap((runtime) =>
            resolveProviderMaintenanceCapabilitiesEffect(
              makeCodexMaintenanceResolver(
                homeLayout.sharedHomePath,
                installation.managedDirectory,
              ),
              {
                binaryPath: runtime.config.binaryPath,
                env: runtime.environment,
              },
            ),
          ),
          Effect.scoped,
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        ),
      );

      const orchestrationAdapter = yield* createCodexAdapterV2(
        {
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config,
        },
        { onUsageLimits: (update) => snapshot.applyUsageLimits(update), resolveRuntime },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Codex orchestration adapter.",
              cause,
            }),
        ),
      );

      // Kick the TTL-gated manifest refresh in the background and classify with the in-memory
      // manifest, so a slow or hung fetch never delays the provider check.
      const checkProvider = modelCatalog.refreshInBackground.pipe(
        Effect.andThen(
          Effect.zipWith(
            resolveRuntime.pipe(
              Effect.flatMap((runtime) =>
                checkCodexProviderStatus(runtime.config, undefined, runtime.environment),
              ),
              Effect.scoped,
            ),
            currentCatalog,
            (draft, catalog) => stampIdentity(applyCodexModelCatalog(draft, catalog)),
            { concurrent: true },
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      );
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CodexSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          Effect.zipWith(
            makePendingCodexProvider(settings.provider),
            currentCatalog,
            (draft, catalog) => stampIdentity(applyCodexModelCatalog(draft, catalog)),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Codex snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeCodexTextGeneration(
        effectiveConfig,
        processEnv,
        snapshot.getSnapshot.pipe(Effect.map((value) => value.models)),
        resolveRuntime,
      );
      const snapshotForCwd = (cwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              resolveRuntime.pipe(
                Effect.flatMap((runtime) =>
                  probeCodexSkillsForCwd({
                    binaryPath: runtime.config.binaryPath,
                    homePath: runtime.config.homePath,
                    launchArgs: resolveCodexLaunchArgs(
                      runtime.config.launchArgs,
                      runtime.environment,
                    ),
                    cwd,
                    environment: runtime.environment,
                  }),
                ),
                Effect.scoped,
                Effect.timeout("20 seconds"),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              ),
            ]).pipe(
              Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail: `Failed to probe Codex skills for '${cwd}'`,
                    cause,
                  }),
              ),
            );

      // Redemption spends something on the user's account. It serialises on
      // the account (instances sharing a Codex home share the credit), keeps
      // one idempotency key until Codex reports an outcome, and is bounded so
      // a hung app-server cannot hold the account lock.
      // Keyed on the directory holding auth.json: an auth-overlay instance has
      // its own account under `effectiveHomePath`, while plain instances share
      // the common home. The continuation key would conflate the two.
      const accountKey = homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath;
      const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = () =>
        resetCreditCoordinator
          .redeem(accountKey, (idempotencyKey) =>
            Effect.gen(function* () {
              const runtime = yield* resolveRuntime;
              const { client } = yield* withCodexAppServerClient({
                binaryPath: runtime.config.binaryPath,
                homePath: runtime.config.homePath,
                launchArgs: resolveCodexLaunchArgs(runtime.config.launchArgs, runtime.environment),
                cwd: process.cwd(),
                environment: runtime.environment,
              });
              const response = yield* client.request("account/rateLimitResetCredit/consume", {
                idempotencyKey,
              });
              return response.outcome;
            }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
          )
          .pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: "Codex could not redeem the reset credit.",
                  cause,
                }),
            ),
            // The windows just changed; re-probe so the snapshot says so. A
            // failed probe republishes the pre-redemption limits rather than
            // marking them failed, so "confirmed" means `checkedAt` moved past
            // what was published before the redemption started.
            Effect.tap((outcome) =>
              Effect.gen(function* () {
                const before = (yield* snapshot.getSnapshot).usageLimits?.checkedAt;
                const refreshed = yield* snapshot.refresh;
                const after = refreshed.usageLimits?.checkedAt;
                if (
                  outcome === "reset" &&
                  (after === undefined ||
                    after === before ||
                    refreshed.usageLimits?.unavailable?.reason === "probeFailed")
                ) {
                  return yield* new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail:
                      "The reset was applied, but Codex could not confirm the new limits. Refresh to check.",
                  });
                }
              }),
            ),
          );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        consumeResetCredit,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
