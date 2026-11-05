import type {
  OrchestrationV2ConversationMessage,
  ProjectId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSettings from "../serverSettings.ts";
import { UsageOrigin, type AttemptRow } from "./usageCohortJoin.ts";

export interface UsageAttemptStampInput {
  readonly attemptId: RunAttemptId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly message: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "scheduledTaskId"
  >;
}

/** Observational, so the default does nothing and turn start tests do not need a layer. */
const encodeSettings = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean)),
);

export class UsageAttemptStamps extends Context.Reference<{
  readonly stamp: (input: UsageAttemptStampInput) => Effect.Effect<void>;
}>("t3/usage/UsageAttemptStamps", {
  defaultValue: () => ({ stamp: () => Effect.void }),
}) {}

export function originOf(message: UsageAttemptStampInput["message"]): UsageOrigin {
  if (message.scheduledTaskId !== undefined) return "scheduled";
  if (message.createdBy === "system" || message.creationSource === "server") {
    return "server_dispatched";
  }
  return message.createdBy;
}

export const layer = Layer.effect(
  UsageAttemptStamps,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const serverSettings = yield* ServerSettings.ServerSettingsService;

    const stamp = Effect.fn("UsageAttemptStamps.stamp")(
      function* (input: UsageAttemptStampInput) {
        const { settings } = resolveProjectSettings(
          yield* serverSettings.getSettings,
          input.projectId,
        );
        const booleans: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(settings)) {
          if (typeof value === "boolean") booleans[key] = value;
        }
        const settingsJson = yield* encodeSettings(booleans);
        yield* sql`
          INSERT INTO usage_attempt_stamps (attempt_id, thread_id, origin, t3_version, settings_json)
          VALUES (${input.attemptId}, ${input.threadId}, ${originOf(input.message)}, ${packageJson.version}, ${settingsJson})
          ON CONFLICT (attempt_id) DO UPDATE SET
            thread_id = excluded.thread_id,
            origin = excluded.origin,
            t3_version = excluded.t3_version,
            settings_json = excluded.settings_json
        `;
      },
      (effect, input) =>
        effect.pipe(
          Effect.catch((error) =>
            Effect.logWarning("usage.attempt-stamp.failed", {
              attemptId: input.attemptId,
              error: error._tag,
            }),
          ),
        ),
    );

    return { stamp };
  }),
);

const AttemptSqlRow = Schema.Struct({
  attempt_id: Schema.String,
  run_id: Schema.String,
  thread_id: Schema.String,
  provider_instance_id: Schema.String,
  session_id: Schema.NullOr(Schema.String),
  started_at: Schema.String,
  completed_at: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(UsageOrigin),
  t3_version: Schema.NullOr(Schema.String),
  settings_json: Schema.NullOr(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean))),
});
const decodeAttemptRows = Schema.decodeUnknownEffect(Schema.Array(AttemptSqlRow));

const FirstSeenSqlRow = Schema.Struct({ t3_version: Schema.String, first_seen: Schema.String });
const decodeFirstSeenRows = Schema.decodeUnknownEffect(Schema.Array(FirstSeenSqlRow));

const toMs = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

/** Attempts that started in the range, with their stamp when they have one. */
export const readAttempts = Effect.fn("UsageAttemptStamps.readAttempts")(function* (
  sql: SqlClient.SqlClient,
  range: { readonly sinceMs: number; readonly untilMs: number },
) {
  const sinceIso = DateTime.formatIso(DateTime.makeUnsafe(range.sinceMs));
  const untilIso = DateTime.formatIso(DateTime.makeUnsafe(range.untilMs));
  const rows = yield* sql`
    SELECT
      a.attempt_id AS attempt_id,
      a.run_id AS run_id,
      a.thread_id AS thread_id,
      COALESCE(a.provider_instance_id, a.provider) AS provider_instance_id,
      json_extract(a.payload_json, '$.nativeThreadId') AS session_id,
      json_extract(a.payload_json, '$.startedAt') AS started_at,
      json_extract(a.payload_json, '$.completedAt') AS completed_at,
      s.origin AS origin,
      s.t3_version AS t3_version,
      s.settings_json AS settings_json
    FROM orchestration_v2_projection_run_attempts a
    LEFT JOIN usage_attempt_stamps s ON s.attempt_id = a.attempt_id
    WHERE json_extract(a.payload_json, '$.startedAt') IS NOT NULL
      AND json_extract(a.payload_json, '$.startedAt') >= ${sinceIso}
      AND json_extract(a.payload_json, '$.startedAt') <= ${untilIso}
  `.pipe(Effect.flatMap(decodeAttemptRows));
  return rows.map((row): AttemptRow => ({
    attemptId: row.attempt_id,
    runId: row.run_id,
    threadId: row.thread_id,
    sessionId: row.session_id ?? "",
    providerInstanceId: row.provider_instance_id,
    startedAtMs: toMs(row.started_at),
    endedAtMs: row.completed_at === null ? null : toMs(row.completed_at),
    stamp:
      row.origin === null || row.t3_version === null || row.settings_json === null
        ? null
        : { origin: row.origin, t3Version: row.t3_version, settings: row.settings_json },
  }));
});

/** When this environment first ran each build, over every stamp it holds. */
export const readBuildFirstSeen = Effect.fn("UsageAttemptStamps.readBuildFirstSeen")(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql`
    SELECT s.t3_version AS t3_version, MIN(json_extract(a.payload_json, '$.startedAt')) AS first_seen
    FROM usage_attempt_stamps s
    JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = s.attempt_id
    WHERE json_extract(a.payload_json, '$.startedAt') IS NOT NULL
    GROUP BY s.t3_version
  `.pipe(Effect.flatMap(decodeFirstSeenRows));
  return new Map(rows.map((row) => [row.t3_version, toMs(row.first_seen)] as const));
});
