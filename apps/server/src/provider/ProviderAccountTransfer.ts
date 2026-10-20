import {
  defaultInstanceIdForDriver,
  PROVIDER_ACCOUNT_SECRET_VALUE_MAX_CHARS,
  PROVIDER_ACCOUNT_SECRETS_MAX,
  type PortableProviderInstance,
  type ProviderAccountExport,
  type ProviderAccountImportResult,
  type ProviderAccountOmission,
  type ProviderAccountSecret,
  ProviderAccountTransferError,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type ProviderSetupError,
  type ServerSettingsError,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Settings from "../serverSettings.ts";
import {
  providerSettingsFieldPolicy,
  type ProviderSettingsFieldPolicy,
} from "../settingsSecrets.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import * as ProviderAuthService from "./ProviderAuthService.ts";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";

export type ProviderDriverDefinition = Pick<
  AnyProviderDriver,
  "driverKind" | "metadata" | "configSchema"
>;

export class ProviderAccountTransfer extends Context.Service<
  ProviderAccountTransfer,
  {
    readonly exportAccount: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<
      ProviderAccountExport,
      ProviderAccountTransferError | ProviderSetupError | ServerSettingsError
    >;
    readonly importAccount: (
      account: ProviderAccountExport,
    ) => Effect.Effect<
      ProviderAccountImportResult,
      ProviderAccountTransferError | ServerSettingsError
    >;
  }
>()("t3/provider/ProviderAccountTransfer") {}

export const makeProviderAccountTransfer = Effect.fn("ProviderAccountTransfer.make")(function* (
  drivers: ReadonlyArray<ProviderDriverDefinition>,
) {
  const settings = yield* Settings.ServerSettingsService;
  const providerAuth = yield* ProviderAuthService.ProviderAuthService;
  const driversByKind = new Map(drivers.map((driver) => [driver.driverKind, driver]));

  const defaultInstanceDrivers = new Map(
    drivers
      .filter((driver) => driver.metadata.hasDefaultInstance !== false)
      .map((driver) => [defaultInstanceIdForDriver(driver.driverKind), driver.driverKind]),
  );
  const implicitDefaultDriver = (instanceId: ProviderInstanceId): ProviderDriverKind | undefined =>
    defaultInstanceDrivers.get(instanceId);

  const requirePolicy = (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => {
    const policy = providerSettingsFieldPolicy(driver);
    return policy === undefined
      ? Effect.fail(new ProviderAccountTransferError({ instanceId, reason: "driver-unavailable" }))
      : Effect.succeed(policy);
  };

  const exportAccount: ProviderAccountTransfer["Service"]["exportAccount"] = Effect.fn(
    "ProviderAccountTransfer.exportAccount",
  )(function* (instanceId) {
    yield* Effect.annotateCurrentSpan({ instanceId });
    const current = yield* settings.getSettings;
    const stored = current.providerInstances[instanceId];
    const driver = stored?.driver ?? implicitDefaultDriver(instanceId);
    if (driver === undefined)
      return yield* new ProviderAccountTransferError({
        instanceId,
        reason: "instance-not-found",
      });
    const policy = yield* requirePolicy(instanceId, driver);
    const credential = yield* providerAuth.readStaticCredential({ instanceId });
    return toPortableAccount(instanceId, stored ?? { driver }, policy, credential);
  });

  const importAccount: ProviderAccountTransfer["Service"]["importAccount"] = Effect.fn(
    "ProviderAccountTransfer.importAccount",
  )(function* (account) {
    const { instanceId } = account;
    yield* Effect.annotateCurrentSpan({ instanceId });
    const policy = yield* requirePolicy(instanceId, account.instance.driver);
    const driver = driversByKind.get(account.instance.driver);
    if (driver === undefined)
      return yield* new ProviderAccountTransferError({
        instanceId,
        reason: "driver-unavailable",
      });
    const decodeConfig = Schema.decodeUnknownEffect(driver.configSchema);

    const committed = yield* settings.reviseProviderInstance(instanceId, (current, all) =>
      Effect.gen(function* () {
        const merged = mergePortableAccount({
          current,
          implicitDriver: implicitDefaultDriver(instanceId),
          account,
          policy,
        });
        if (merged._tag === "Conflict")
          return yield* new ProviderAccountTransferError({
            instanceId,
            reason: "instance-id-conflict",
          });
        const secondInstance =
          merged.change === "created" &&
          driver.metadata.supportsMultipleInstances === false &&
          (driver.metadata.hasDefaultInstance !== false ||
            Object.values(all.providerInstances).some(
              (instance) => instance.driver === driver.driverKind,
            ));
        if (secondInstance)
          return yield* new ProviderAccountTransferError({
            instanceId,
            reason: "single-instance",
          });
        // The decoded value is discarded: the stored form keeps fields this build doesn't know,
        // as a hand edit would.
        yield* decodeConfig(merged.instance.config).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAccountTransferError({ instanceId, reason: "invalid-config", cause }),
          ),
        );
        return { instance: merged.instance, result: merged };
      }),
    );
    return { instanceId, change: committed.result.change, omitted: committed.result.omitted };
  });

  return ProviderAccountTransfer.of({ exportAccount, importAccount });
});

export const layer = Layer.effect(
  ProviderAccountTransfer,
  makeProviderAccountTransfer(BUILT_IN_DRIVERS),
);

/**
 * Conservative on purpose: a false positive stays behind and is listed, it never copies a wrong
 * path silently.
 */
const MACHINE_LOCAL_ENVIRONMENT_VARIABLES: ReadonlySet<string> = new Set([
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "HOME",
  "PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "GROK_HOME",
  "PI_CODING_AGENT_DIR",
]);
const PATH_SHAPED_VALUE = /^(~|\/|[A-Za-z]:[\\/]|\\\\)/;

function isMachineLocalVariable(variable: {
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
}): boolean {
  return (
    !variable.sensitive &&
    (MACHINE_LOCAL_ENVIRONMENT_VARIABLES.has(variable.name) ||
      PATH_SHAPED_VALUE.test(variable.value.trim()))
  );
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  isRecord(value) ? value : {};

const configField = (field: string) => ({ _tag: "ConfigField", field }) as const;
const environmentVariable = (name: string) => ({ _tag: "EnvironmentVariable", name }) as const;

/** `instance` must be materialized: its secrets are plaintext, not redaction markers. */
function toPortableAccount(
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig,
  policy: ProviderSettingsFieldPolicy,
  credential: Option.Option<{ readonly name: string; readonly value: string }>,
): ProviderAccountExport {
  const secrets: Array<ProviderAccountSecret> = [];
  const omitted: Array<ProviderAccountOmission> = [];
  // The destination rejects an export past either limit as a whole, so the source drops the
  // excess slot and says so instead.
  const addSecret = (secret: ProviderAccountSecret) => {
    if (
      secret.value.length > PROVIDER_ACCOUNT_SECRET_VALUE_MAX_CHARS ||
      secrets.length >= PROVIDER_ACCOUNT_SECRETS_MAX
    )
      omitted.push({
        setting:
          secret._tag === "ConfigField"
            ? configField(secret.field)
            : environmentVariable(secret.name),
        reason: "too-large",
      });
    else secrets.push(secret);
  };
  const config: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(asRecord(instance.config))) {
    if (policy.machineLocal.has(field)) {
      omitted.push({ setting: configField(field), reason: "machine-local" });
    } else if (policy.secret.has(field)) {
      if (typeof value === "string" && value.length > 0)
        addSecret({ _tag: "ConfigField", field, value });
      else omitted.push({ setting: configField(field), reason: "missing-on-source" });
    } else {
      config[field] = value;
    }
  }
  const environment: Array<PortableProviderInstance["environment"][number]> = [];
  for (const variable of instance.environment ?? []) {
    if (variable.sensitive) {
      if (variable.value.length > 0)
        addSecret({ _tag: "EnvironmentVariable", name: variable.name, value: variable.value });
      else
        omitted.push({ setting: environmentVariable(variable.name), reason: "missing-on-source" });
    } else if (isMachineLocalVariable(variable)) {
      omitted.push({ setting: environmentVariable(variable.name), reason: "machine-local" });
    } else {
      environment.push({ name: variable.name, value: variable.value });
    }
  }
  if (
    Option.isSome(credential) &&
    !(instance.environment ?? []).some((variable) => variable.name === credential.value.name)
  ) {
    addSecret({ _tag: "EnvironmentVariable", ...credential.value });
  }
  return {
    instanceId,
    instance: {
      driver: instance.driver,
      ...(instance.displayName === undefined ? {} : { displayName: instance.displayName }),
      ...(instance.accentColor === undefined ? {} : { accentColor: instance.accentColor }),
      enabled: resolveProviderInstanceEnabled(instance),
      config,
      environment,
    },
    secrets,
    omitted,
  };
}

type MergeOutcome =
  | { readonly _tag: "Conflict" }
  | {
      readonly _tag: "Merged";
      readonly instance: ProviderInstanceConfig;
      readonly change: ProviderAccountImportResult["change"];
      readonly omitted: ReadonlyArray<ProviderAccountOmission>;
    };

function mergePortableAccount(input: {
  readonly current: ProviderInstanceConfig | undefined;
  readonly implicitDriver: ProviderDriverKind | undefined;
  readonly account: ProviderAccountExport;
  readonly policy: ProviderSettingsFieldPolicy;
}): MergeOutcome {
  const { current, implicitDriver, account, policy } = input;
  const incoming = account.instance;
  const existingDriver = current?.driver ?? implicitDriver;
  if (existingDriver !== undefined && existingDriver !== incoming.driver)
    return { _tag: "Conflict" };

  const omitted: Array<ProviderAccountOmission> = [...account.omitted];
  const config: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(incoming.config)) {
    if (policy.machineLocal.has(field)) {
      omitted.push({ setting: configField(field), reason: "machine-local" });
      continue;
    }
    // A field this machine treats as secret but the source sent as plain was plaintext there
    // too; persistSettingsSecrets moves it into this machine's store like a hand edit.
    config[field] = value;
  }
  for (const secret of account.secrets) {
    if (secret._tag !== "ConfigField") continue;
    if (policy.secret.has(secret.field)) config[secret.field] = secret.value;
    else omitted.push({ setting: configField(secret.field), reason: "unsupported-here" });
  }
  const currentConfig = asRecord(current?.config);
  for (const field of policy.machineLocal) {
    if (field in currentConfig) config[field] = currentConfig[field];
  }
  // What didn't travel must not erase a working secret here.
  const notSent = account.omitted.filter(
    (omission) => omission.reason === "missing-on-source" || omission.reason === "too-large",
  );
  for (const { setting } of notSent) {
    if (
      setting._tag === "ConfigField" &&
      policy.secret.has(setting.field) &&
      setting.field in currentConfig
    )
      config[setting.field] = currentConfig[setting.field];
  }

  const portableVariables: Array<ProviderInstanceEnvironmentVariable> = [];
  for (const variable of incoming.environment) {
    if (isMachineLocalVariable({ ...variable, sensitive: false }))
      omitted.push({ setting: environmentVariable(variable.name), reason: "machine-local" });
    else portableVariables.push({ name: variable.name, value: variable.value, sensitive: false });
  }
  const secretVariables = account.secrets.flatMap((secret) =>
    secret._tag === "EnvironmentVariable"
      ? [{ name: secret.name, value: secret.value, sensitive: true }]
      : [],
  );
  const incomingNames = new Set(
    [...portableVariables, ...secretVariables].map((variable) => variable.name),
  );
  const missingVariableNames = new Set(
    notSent.flatMap(({ setting }) =>
      setting._tag === "EnvironmentVariable" ? [setting.name] : [],
    ),
  );
  const keptVariables = (current?.environment ?? []).filter(
    (variable) =>
      !incomingNames.has(variable.name) &&
      (isMachineLocalVariable(variable) ||
        (variable.sensitive && missingVariableNames.has(variable.name))),
  );
  const environment = [...keptVariables, ...portableVariables, ...secretVariables];

  const exists = current !== undefined || implicitDriver !== undefined;
  const enabled = exists ? current?.enabled : incoming.enabled;
  return {
    _tag: "Merged",
    change: exists ? "updated" : "created",
    omitted,
    instance: {
      driver: incoming.driver,
      ...(incoming.displayName === undefined ? {} : { displayName: incoming.displayName }),
      ...(incoming.accentColor === undefined ? {} : { accentColor: incoming.accentColor }),
      ...(enabled === undefined ? {} : { enabled }),
      config,
      ...(environment.length === 0 ? {} : { environment }),
    },
  };
}
