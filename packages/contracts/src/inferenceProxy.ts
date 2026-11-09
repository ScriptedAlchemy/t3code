import * as Schema from "effect/Schema";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

import { ProviderInstanceId } from "./providerInstance.ts";

export const isInferenceConfig = Schema.is(
  Schema.Struct({ setupMode: Schema.Literal("inference") }),
);

const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const State = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export const InferenceDriver = Schema.Literals(["codex", "claudeAgent"]);
export type InferenceDriver = typeof InferenceDriver.Type;

export const InferenceConsumer = Schema.Struct({ environmentId: EnvironmentId, label: Label });
export type InferenceConsumer = typeof InferenceConsumer.Type;

const ModelId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(192),
  Schema.isPattern(/^[^\r\n\t]+$/),
);
const PoolName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^[a-z0-9][a-z0-9.-]*$/),
);
const ModelSource = Schema.Literals(["codex", "claudeAgent", "traex"]);
export const InferenceModelMapping = Schema.Struct({
  source: ModelSource,
  upstream: ModelId,
  pool: PoolName,
});
export const isInferenceModelMapping = Schema.is(InferenceModelMapping);
export const inferenceSourceLabels = {
  codex: "Codex accounts",
  claudeAgent: "Claude accounts",
  traex: "Traex bridge (Codex)",
} as const;
export type InferenceModelMapping = typeof InferenceModelMapping.Type;
export const inferencePoolModel = (mapping: Pick<InferenceModelMapping, "source" | "pool">) =>
  (mapping.source === "claudeAgent" ? "claude-pool-" : "codex-pool-") + mapping.pool;
const Strategy = Schema.Literals(["round-robin", "fill-first"]);
export const InferenceRouting = Schema.Struct({
  strategy: Strategy,
  sessionAffinity: Schema.Boolean,
  mappings: Schema.Array(InferenceModelMapping).check(Schema.isMaxLength(128)),
});
export type InferenceRouting = typeof InferenceRouting.Type;
export const defaultInferenceRouting: InferenceRouting = {
  strategy: "round-robin",
  sessionAffinity: true,
  mappings: [],
};

export const InferenceProxyStatus = Schema.Struct({
  enabled: Schema.Boolean,
  sharing: Schema.Boolean,
  running: Schema.Boolean,
  version: Schema.String,
  routing: Schema.optionalKey(InferenceRouting),
  problem: Schema.NullOr(Schema.String),
  accounts: Schema.Array(
    Schema.Struct({ name: Schema.String, provider: Schema.String, status: Schema.String }),
  ),
  consumers: Schema.Array(InferenceConsumer),
  routes: Schema.Array(Schema.Struct({ instanceId: ProviderInstanceId, label: Schema.String })),
});
export type InferenceProxyStatus = typeof InferenceProxyStatus.Type;

export function inferenceRouteIssue(host: InferenceProxyStatus | null, local: boolean) {
  if (!host) return "Host status unavailable.";
  if (!host.enabled) return "Enable inference hosting on this environment first.";
  if (!host.running) return host.problem ?? "The inference host is stopped.";
  if (!local && !host.sharing) return "Enable sharing on the host first.";
  if (
    !host.accounts.length &&
    !host.routing?.mappings.some((mapping) => mapping.source === "traex")
  )
    return "Add a provider account on the host first.";
  return null;
}

export const InferenceProxyAction = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("listModels"), source: ModelSource }),
  Schema.Struct({ operation: Schema.Literals(["checkUpdate", "update"]) }),
  Schema.Struct({
    operation: Schema.Literal("setRouting"),
    strategy: Schema.optionalKey(Strategy),
    sessionAffinity: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ operation: Schema.Literal("mapModel"), mapping: InferenceModelMapping }),
  Schema.Struct({ operation: Schema.Literal("unmapModel"), source: ModelSource, pool: PoolName }),
  Schema.Struct({
    operation: Schema.Literal("configure"),
    enabled: Schema.Boolean,
    sharing: Schema.Boolean,
  }),
  Schema.Struct({ operation: Schema.Literal("signIn"), driver: InferenceDriver }),
  Schema.Struct({
    operation: Schema.Literal("callback"),
    state: State,
    callback: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
  }),
  Schema.Struct({ operation: Schema.Literal("check"), state: State }),
  Schema.Struct({ operation: Schema.Literal("cancel"), state: State }),
  Schema.Struct({ operation: Schema.Literal("removeAccount"), name: Label }),
  Schema.Struct({ operation: Schema.Literal("removeRoute"), instanceId: ProviderInstanceId }),
  Schema.Struct({ operation: Schema.Literal("revoke"), environmentId: EnvironmentId }),
]);
export type InferenceProxyAction = typeof InferenceProxyAction.Type;
export const InferenceProxyActionResult = Schema.Struct({
  models: Schema.optionalKey(Schema.Array(Schema.String)),
  update: Schema.optionalKey(
    Schema.Struct({ current: Schema.String, available: Schema.NullOr(Schema.String) }),
  ),
  login: Schema.optionalKey(Schema.Struct({ url: Schema.String, state: State })),
  status: Schema.optionalKey(Schema.Literals(["wait", "ok", "error"])),
});
export type InferenceProxyActionResult = typeof InferenceProxyActionResult.Type;

export const InferenceRouteGrant = Schema.Struct({
  hostId: EnvironmentId,
  consumerId: EnvironmentId,
  baseUrl: Schema.String,
  alternates: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(32))),
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type InferenceRouteGrant = typeof InferenceRouteGrant.Type;
export const InferenceRouteInput = Schema.Struct({
  grant: InferenceRouteGrant,
  driver: InferenceDriver,
  hostLabel: Label,
});
export type InferenceRouteInput = typeof InferenceRouteInput.Type;
export class InferenceProxyError extends Schema.TaggedError<InferenceProxyError>()(
  "InferenceProxyError",
  {
    message: Schema.String,
  },
) {}
