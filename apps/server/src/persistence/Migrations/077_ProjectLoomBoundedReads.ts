import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// project.readLoomWindow reads only what overlaps its window.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Runs requested before the window that completed inside or after it. requested_at rides along
  // so the index alone rules out runs requested inside the window.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_thread_completed_idx
    ON orchestration_v2_projection_runs(thread_id, completed_at, requested_at)
  `;
  // Newest command items of a run, ordered without reading their payloads.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_run_command_updated_idx
    ON orchestration_v2_projection_turn_items(run_id, updated_at)
    WHERE type = 'command_execution'
  `;
  // Linking a pull request does not advance a thread's updated_at, so threads quiet since before
  // the window are found through their links.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_project_linked_idx
    ON orchestration_v2_projection_threads(project_id, updated_at)
    WHERE json_array_length(payload_json, '$.pullRequests') > 0
  `;
});
