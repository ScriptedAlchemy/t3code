import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const claudeTelemetryOptOut = {
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
  CLAUDE_CODE_ENABLE_TELEMETRY: "0",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL: "0",
} as const;

// ACP distributions and wrappers can start a different harness underneath their executable.
const providerTelemetryOptOut = {
  ...claudeTelemetryOptOut,
  // Copilot also enables OTel when either destination is present, even without its enable flag.
  COPILOT_OTEL_ENABLED: "false",
  COPILOT_OTEL_FILE_EXPORTER_PATH: "",
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
  DO_NOT_TRACK: "1",
  OTEL_SDK_DISABLED: "true",
  OTEL_LOGS_EXPORTER: "none",
  OTEL_METRICS_EXPORTER: "none",
  OTEL_TRACES_EXPORTER: "none",
  GEMINI_TELEMETRY_ENABLED: "false",
  GEMINI_TELEMETRY_TRACES_ENABLED: "false",
  GROK_TELEMETRY_ENABLED: "false",
  GROK_TELEMETRY_TRACE_UPLOAD: "false",
  GROK_EXTERNAL_OTEL: "0",
  KIRO_TELEMETRY_ENABLED: "false",
} as const;

export function providerProcessEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...environment, ...providerTelemetryOptOut };
  if (platform === "win32") {
    for (const name of Object.keys(environment ?? {})) {
      const upper = name.toUpperCase();
      if (name !== upper && Object.hasOwn(providerTelemetryOptOut, upper)) delete next[name];
    }
  }
  return next;
}

// Custom OTLP exporters in Codex are independent of analytics consent.
export const codexTelemetryConfig = {
  analytics: { enabled: false },
  feedback: { enabled: false },
  otel: {
    exporter: "none",
    trace_exporter: "none",
    metrics_exporter: "none",
    log_user_prompt: false,
  },
} as const;

const configRecord = Schema.Record(Schema.String, Schema.Unknown);
const isConfigRecord = Schema.is(configRecord);
const decodeConfig = Schema.decodeUnknownOption(fromLenientJson(configRecord));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(configRecord));

export function mergeTelemetryConfig(
  content: string | undefined,
  policy: Readonly<Record<string, Readonly<Record<string, boolean | string>>>>,
): string {
  const config = decodeConfig(content ?? "{}");
  // Preserve the harness's own error for an invalid config instead of discarding its settings.
  if (Option.isNone(config)) return content ?? "{}";
  const result = { ...config.value };
  for (const [key, values] of Object.entries(policy)) {
    const existing = result[key];
    if (existing !== undefined && !isConfigRecord(existing)) return content ?? "{}";
    result[key] = { ...existing, ...values };
  }
  return encodeConfig(result);
}
