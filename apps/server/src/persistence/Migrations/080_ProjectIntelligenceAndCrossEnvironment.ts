import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Preview builds may already have part of this schema.
  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(project_knowledge_deliveries)`;
  for (const name of ["provider_thread_id", "native_thread_id", "budget_json"]) {
    if (!columns.some((column) => column.name === name)) {
      yield* sql`ALTER TABLE project_knowledge_deliveries ADD COLUMN ${sql(name)} TEXT`;
    }
  }

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
  yield* sql`
    CREATE TABLE IF NOT EXISTS cross_environment_launches (
      command_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      destination_json TEXT,
      result_json TEXT,
      CHECK (result_json IS NULL OR destination_json IS NOT NULL)
    )
  `;
});
