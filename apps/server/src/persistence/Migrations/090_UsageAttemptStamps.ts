import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE usage_attempt_stamps (
      attempt_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      t3_version TEXT NOT NULL,
      settings_json TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_run_attempts_started_at_idx
    ON orchestration_v2_projection_run_attempts (json_extract(payload_json, '$.startedAt'))
    WHERE json_extract(payload_json, '$.startedAt') IS NOT NULL
  `;
});
