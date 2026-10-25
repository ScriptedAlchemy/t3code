import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A narrow window must not scan a long run's complete item history or provider payloads.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_run_updated_idx
    ON orchestration_v2_projection_turn_items(run_id, updated_at, type, thread_id)
  `;
  // Command markers use their start (or recorded completion), not their latest update time.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_run_command_at_idx
    ON orchestration_v2_projection_turn_items(
      run_id,
      COALESCE(json_extract(payload_json, '$.startedAt'), json_extract(payload_json, '$.completedAt'))
    )
    WHERE type = 'command_execution'
  `;
});
