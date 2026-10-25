import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A rebuildable cache derived from checkpoint projections: dropping both tables loses nothing.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE project_code_checkpoint_files (
      path TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      additions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      PRIMARY KEY (path, checkpoint_id)
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX project_code_checkpoint_files_checkpoint ON project_code_checkpoint_files(checkpoint_id)`;
  // What each indexed checkpoint looked like when indexed, so a recapture is re-read.
  yield* sql`
    CREATE TABLE project_code_checkpoint_marks (
      checkpoint_id TEXT PRIMARY KEY NOT NULL,
      captured_at TEXT NOT NULL,
      status TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});
