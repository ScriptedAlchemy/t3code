import type {
  OrchestrationV2ConversationMessage,
  ProjectId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSettings from "../serverSettings.ts";
import type { UsageOrigin } from "./usageCohortJoin.ts";

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
