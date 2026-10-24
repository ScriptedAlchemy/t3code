import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A checkpoint's files are indexed a page at a time; `next_file_index` is where the next page
// starts, NULL once every file is indexed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_code_checkpoint_marks ADD COLUMN next_file_index INTEGER`;
  // Marks written before paging recorded checkpoints cut off at their first 2,000 files as done.
  yield* sql`
    DELETE FROM project_code_checkpoint_marks
    WHERE checkpoint_id IN (
      SELECT checkpoint_id FROM orchestration_v2_projection_checkpoints
      WHERE json_type(payload_json, '$.files') = 'array'
        AND json_array_length(payload_json, '$.files') > 2000
    )
  `;
});
