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
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET default_provider = IIF(default_provider GLOB ${pattern}, ${instanceId}, default_provider),
        provider_instance_id =
          IIF(provider_instance_id GLOB ${pattern}, ${instanceId}, provider_instance_id),
        payload_json = json_set(payload_json,
          '$.providerInstanceId', ${instanceId}, '$.modelSelection.instanceId', ${instanceId})
      WHERE json_valid(payload_json)
        AND json_extract(payload_json, '$.modelSelection.instanceId') GLOB ${pattern}
    `;
    // Finished runs keep the instance they ran on; only runs still waiting to start move.
    yield* sql`
      UPDATE orchestration_v2_projection_runs
      SET provider_instance_id = ${instanceId},
        payload_json = json_replace(payload_json,
          '$.providerInstanceId', ${instanceId}, '$.modelSelection.instanceId', ${instanceId})
      WHERE status = 'queued'
        AND json_valid(payload_json)
        AND json_extract(payload_json, '$.providerInstanceId') GLOB ${pattern}
    `;
    yield* sql`
      UPDATE scheduled_tasks
      SET model_selection_json = json_set(model_selection_json, '$.instanceId', ${instanceId})
      WHERE json_valid(model_selection_json)
        AND json_extract(model_selection_json, '$.instanceId') GLOB ${pattern}
    `;
  }
});
