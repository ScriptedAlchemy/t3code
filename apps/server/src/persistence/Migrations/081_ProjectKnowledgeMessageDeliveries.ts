import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE project_knowledge_message_deliveries (
      attempt_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('prepared', 'sent', 'failed', 'uncertain')),
      items_json TEXT NOT NULL,
      omissions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      provider_thread_id TEXT,
      native_thread_id TEXT,
      budget_json TEXT,
      PRIMARY KEY (attempt_id, message_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    INSERT INTO project_knowledge_message_deliveries
    SELECT attempt_id, run_id, thread_id, message_id, project_id, provider_instance_id,
      status, items_json, omissions_json, created_at, updated_at,
      provider_thread_id, native_thread_id, budget_json
    FROM project_knowledge_deliveries
  `;
  yield* sql`DROP TABLE project_knowledge_deliveries`;
  yield* sql`ALTER TABLE project_knowledge_message_deliveries RENAME TO project_knowledge_deliveries`;
  yield* sql`CREATE INDEX project_knowledge_deliveries_message
    ON project_knowledge_deliveries(project_id, thread_id, message_id, created_at)`;
  yield* sql`CREATE INDEX project_knowledge_deliveries_project_cursor
    ON project_knowledge_deliveries(project_id, attempt_id, message_id)`;
});
