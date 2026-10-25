import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per run attempt: retrying an attempt updates its row, while a replacement attempt
  // (account failover) records what it delivered separately.
  yield* sql`
    CREATE TABLE project_knowledge_deliveries (
      attempt_id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('prepared', 'sent', 'failed', 'uncertain')),
      items_json TEXT NOT NULL,
      omissions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX project_knowledge_deliveries_message ON project_knowledge_deliveries(project_id, thread_id, message_id, created_at)`;
});
