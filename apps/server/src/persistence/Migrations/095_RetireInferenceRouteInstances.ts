import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const HEX_16 = "[0-9a-f]".repeat(16);
// Account pools and per-host route instances became a mode of the driver's default instance.
const RETIRED = ["codex", "claudeAgent"].flatMap((driver) => [
  { pattern: `pool_${driver}`, instanceId: driver },
  { pattern: `inference_${driver}_${HEX_16}`, instanceId: driver },
]);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const { pattern, instanceId } of RETIRED) {
    // The native conversation stays on the old instance, so the next turn hands off from it.
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET default_provider = ${instanceId},
        provider_instance_id = ${instanceId},
        payload_json = json_replace(payload_json, '$.providerInstanceId', ${instanceId})
      WHERE json_valid(payload_json)
        AND json_extract(payload_json, '$.providerInstanceId') GLOB ${pattern}
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = json_replace(payload_json, '$.modelSelection.instanceId', ${instanceId})
      WHERE json_valid(payload_json)
        AND json_extract(payload_json, '$.modelSelection.instanceId') GLOB ${pattern}
    `;
    // Finished work keeps the instance it ran on. Only work still waiting to start moves.
    yield* sql`
      UPDATE orchestration_v2_projection_runs
      SET provider = ${instanceId},
        provider_instance_id = ${instanceId},
        payload_json = json_replace(payload_json,
          '$.providerInstanceId', ${instanceId}, '$.modelSelection.instanceId', ${instanceId})
      WHERE status = 'queued'
        AND json_valid(payload_json)
        AND json_extract(payload_json, '$.providerInstanceId') GLOB ${pattern}
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_run_attempts
      SET provider = ${instanceId},
        provider_instance_id = ${instanceId},
        payload_json = json_replace(payload_json, '$.providerInstanceId', ${instanceId})
      WHERE run_id IN (SELECT run_id FROM orchestration_v2_projection_runs WHERE status = 'queued')
        AND json_valid(payload_json)
        AND json_extract(payload_json, '$.providerInstanceId') GLOB ${pattern}
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_provider_threads
      SET provider = ${instanceId},
        provider_instance_id = ${instanceId},
        payload_json = json_replace(payload_json, '$.providerInstanceId', ${instanceId})
      WHERE status = 'not_loaded'
        AND first_run_ordinal IS NULL
        AND provider_session_id IS NULL
        AND json_valid(payload_json)
        AND json_extract(payload_json, '$.nativeThreadRef') IS NULL
        AND json_extract(payload_json, '$.providerInstanceId') GLOB ${pattern}
    `;
    yield* sql`
      UPDATE scheduled_tasks
      SET model_selection_json = json_replace(model_selection_json, '$.instanceId', ${instanceId})
      WHERE json_valid(model_selection_json)
        AND json_extract(model_selection_json, '$.instanceId') GLOB ${pattern}
    `;
    yield* sql`
      UPDATE scheduled_task_webhook_pending
      SET task_json = json_replace(task_json, '$.modelSelection.instanceId', ${instanceId})
      WHERE json_valid(task_json)
        AND json_extract(task_json, '$.modelSelection.instanceId') GLOB ${pattern}
    `;
    yield* sql`
      UPDATE projection_projects
      SET default_model_selection_json =
        json_replace(default_model_selection_json, '$.instanceId', ${instanceId})
      WHERE json_valid(default_model_selection_json)
        AND json_extract(default_model_selection_json, '$.instanceId') GLOB ${pattern}
    `;
  }
});
