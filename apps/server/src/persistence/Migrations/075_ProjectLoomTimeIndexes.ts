import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// project.readLoomWindow reads a page of threads' runs and checkpoints by time.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_thread_requested_idx
    ON orchestration_v2_projection_runs(thread_id, requested_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_checkpoints_thread_captured_idx
    ON orchestration_v2_projection_checkpoints(thread_id, captured_at)
  `;
});
