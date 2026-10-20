import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProviderDriverKind,
  ProviderInstanceEnvironmentVariableName,
  ProviderInstanceId,
} from "./providerInstance.ts";

export const PROVIDER_ACCOUNT_SECRET_VALUE_MAX_CHARS = 16_384;
export const PROVIDER_ACCOUNT_SECRETS_MAX = 64;

const ProviderSettingsFieldName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_]*$/),
);

const SecretValue = Schema.NonEmptyString.check(
  Schema.isMaxLength(PROVIDER_ACCOUNT_SECRET_VALUE_MAX_CHARS),
);

/**
 * A slot names WHAT the secret is, never WHERE it is stored: the destination derives every
 * secret-store name itself (settingsSecrets.ts) and accepts a slot only when its own schema
 * declares it a secret.
 */
export const ProviderAccountSecret = Schema.Union([
  Schema.TaggedStruct("EnvironmentVariable", {
    name: ProviderInstanceEnvironmentVariableName,
    value: SecretValue,
  }),
  Schema.TaggedStruct("ConfigField", {
    field: ProviderSettingsFieldName,
    value: SecretValue,
  }),
]);
export type ProviderAccountSecret = typeof ProviderAccountSecret.Type;

export const ProviderAccountSetting = Schema.Union([
  Schema.TaggedStruct("ConfigField", { field: ProviderSettingsFieldName }),
  Schema.TaggedStruct("EnvironmentVariable", { name: ProviderInstanceEnvironmentVariableName }),
]);
export type ProviderAccountSetting = typeof ProviderAccountSetting.Type;

/**
 * `machine-local`: describes the source machine (paths, binaries).
 * `unsupported-here`: the destination's build does not recognize it.
 * `missing-on-source`: the source declares it a secret but holds no value for it.
 * `too-large`: the source holds a secret that exceeds the transfer limits.
 */
export const ProviderAccountOmission = Schema.Struct({
  setting: ProviderAccountSetting,
  reason: Schema.Literals(["machine-local", "unsupported-here", "missing-on-source", "too-large"]),
});
export type ProviderAccountOmission = typeof ProviderAccountOmission.Type;

/**
 * Unlike `ProviderInstanceConfig`, environment variables carry no `sensitive` or `valueRedacted`
 * keys: a sensitive variable travels only as a secret slot, so a redaction marker can never be
 * mistaken for a value.
 */
export const PortableProviderInstance = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.optionalKey(Schema.Boolean),
  config: Schema.Record(Schema.String, Schema.Unknown),
  environment: Schema.Array(
    Schema.Struct({
      name: ProviderInstanceEnvironmentVariableName,
      value: Schema.String,
    }),
  ),
});
export type PortableProviderInstance = typeof PortableProviderInstance.Type;

/**
 * Produced only by the source server.
 *
 * Invariants, established by the source and re-checked by the destination (neither trusts the
 * other's classification):
 *  - `instance.config` holds no secret field and no machine-local field;
 *  - `instance.environment` holds only non-sensitive, non-machine-local variables;
 *  - every secret is in `secrets`, each at most once per slot.
 *
 * Holds plaintext. Clients keep it only inside the sync fiber that relays it: never in an atom,
 * never persisted, never logged.
 */
export const ProviderAccountExport = Schema.Struct({
  /** The source's id. The destination reuses it as the target id: identity across machines. */
  instanceId: ProviderInstanceId,
  instance: PortableProviderInstance,
  secrets: Schema.Array(ProviderAccountSecret).check(
    Schema.isMaxLength(PROVIDER_ACCOUNT_SECRETS_MAX),
  ),
  omitted: Schema.Array(ProviderAccountOmission),
});
export type ProviderAccountExport = typeof ProviderAccountExport.Type;

export const ProviderAccountExportInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderAccountExportInput = typeof ProviderAccountExportInput.Type;

export const ProviderAccountImportInput = Schema.Struct({
  account: ProviderAccountExport,
});
export type ProviderAccountImportInput = typeof ProviderAccountImportInput.Type;

export const ProviderAccountImportResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  /**
   * `created`: the destination had no such account. An implicit default instance (unconfigured
   * `cursor`, `codex`, ...) counts as existing: the user already sees it there, so it is `updated`.
   */
  change: Schema.Literals(["created", "updated"]),
  omitted: Schema.Array(ProviderAccountOmission),
});
export type ProviderAccountImportResult = typeof ProviderAccountImportResult.Type;

export const ProviderAccountTransferFailure = Schema.Literals([
  "instance-not-found",
  "driver-unavailable",
  /** Import: the destination uses this id for a different driver. */
  "instance-id-conflict",
  /** Import: the destination's driver allows one instance, and it already has it. */
  "single-instance",
  "invalid-config",
]);
export type ProviderAccountTransferFailure = typeof ProviderAccountTransferFailure.Type;

export class ProviderAccountTransferError extends Schema.TaggedError<ProviderAccountTransferError>()(
  "ProviderAccountTransferError",
  {
    instanceId: ProviderInstanceId,
    reason: ProviderAccountTransferFailure,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "instance-not-found":
        return "This account no longer exists on the source.";
      case "driver-unavailable":
        return "This environment doesn't have this provider. Update it, then sync again.";
      case "instance-id-conflict":
        return "This environment already has a different provider with this account's ID.";
      case "single-instance":
        return "This environment allows only one account for this provider.";
      case "invalid-config":
        return "This account's settings aren't valid for this environment's version of the provider.";
    }
  }
}
export const isProviderAccountTransferError = Schema.is(ProviderAccountTransferError);
