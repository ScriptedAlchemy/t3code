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
  // The peer token stays in the secret store under the row's unique secret name.
  yield* sql`
    CREATE TABLE IF NOT EXISTS peer_environment_links (
      environment_id TEXT PRIMARY KEY,
      secret_name TEXT NOT NULL,
      label TEXT NOT NULL,
      urls_json TEXT NOT NULL,
      access TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_reached_at TEXT,
      last_error TEXT,
      fenced INTEGER NOT NULL DEFAULT 0
    )
  `;
  // Older peer previews did not mark link-issued sessions; those links must be made again.
  const peerColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(peer_environment_links)`;
  if (!peerColumns.some((column) => column.name === "fenced")) {
    yield* sql`ALTER TABLE peer_environment_links ADD COLUMN fenced INTEGER NOT NULL DEFAULT 0`;
  }
  // Keep this predicate aligned with ProjectionStore's waiting link card query.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_waiting_link_idx
    ON orchestration_v2_projection_turn_items(thread_id, updated_at DESC, turn_item_id DESC)
    WHERE type = 'link_request' AND status = 'waiting'
  `;
});
