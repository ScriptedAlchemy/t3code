import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per fact a thread's agent read through its tools. Recall skips these facts, as it
  // skips facts already delivered with a message.
  yield* sql`
    CREATE TABLE project_knowledge_views (
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      PRIMARY KEY (project_id, thread_id, fact_id)
    ) WITHOUT ROWID
  `;
});
