import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per run that assisted learning finished with. It is what keeps a retried or
  // replayed job from calling the model again for a run, and the project's last outcome.
  yield* sql`
    CREATE TABLE project_knowledge_assisted_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      run_outcome TEXT NOT NULL CHECK (run_outcome IN ('completed', 'failed', 'interrupted')),
      result TEXT NOT NULL CHECK (result IN ('ran', 'skipped', 'failed')),
      reason TEXT,
      proposed INTEGER NOT NULL CHECK (proposed >= 0),
      suggested INTEGER NOT NULL CHECK (suggested >= 0),
      completed_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX project_knowledge_assisted_runs_project ON project_knowledge_assisted_runs(project_id, completed_at)`;
});
