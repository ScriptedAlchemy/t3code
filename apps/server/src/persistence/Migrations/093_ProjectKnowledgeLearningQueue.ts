import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_knowledge_learning_queue (
    run_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    root_thread_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    run_outcome TEXT NOT NULL,
    queued_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX project_knowledge_learning_queue_family
    ON project_knowledge_learning_queue(project_id, root_thread_id, queued_at, run_id)`;
});
