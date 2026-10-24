import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Search receipts are short-lived paging state and expire by age. Rows written before they
  // carried a timestamp cannot be aged, so they go; their cursors report invalid_cursor.
  yield* sql`ALTER TABLE project_knowledge_commands ADD COLUMN created_at TEXT`;
  yield* sql`DELETE FROM project_knowledge_commands WHERE search_json IS NOT NULL`;
  yield* sql`
    CREATE INDEX project_knowledge_commands_search_age ON project_knowledge_commands(created_at)
    WHERE search_json IS NOT NULL
  `;
});
