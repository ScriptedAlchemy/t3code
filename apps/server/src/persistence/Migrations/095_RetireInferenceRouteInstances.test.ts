import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const at = "2026-11-10T00:00:00.000Z";
const route = "inference_codex_1ce3f6740fb26811";

layer("095_RetireInferenceRouteInstances", (it) => {
  it.effect("moves saved selections off retired pool and route instances", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 94 });
      const saved = [
        [route, "codex"],
        ["inference_claudeAgent_1ce3f6740fb26811", "claudeAgent"],
        ["pool_codex", "codex"],
        ["pool_claudeAgent", "claudeAgent"],
        // Not retired shapes: a named instance and a pool for a driver that never had one.
        ["inference_codex_host", "inference_codex_host"],
        ["codex_work", "codex_work"],
        ["pool_cursor", "pool_cursor"],
      ] as const;
      const selection = (instanceId: string) => ({ instanceId, model: "gpt-6" });
      const task = (instanceId: string) => ({
        task_id: instanceId,
        title: "task",
        prompt: "Run",
        enabled: 1,
        schedule_json: '{"type":"interval","everyMs":60000}',
        project_id: "project",
        thread_id: null,
        workspace_strategy_json: '{"type":"root"}',
        model_selection_json: JSON.stringify(selection(instanceId)),
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_by: "user",
        creation_source: "web",
        created_at: at,
        updated_at: at,
        next_run_at: null,
        last_run_at: null,
        last_run_status: "never",
        last_run_error: null,
        run_count: 0,
      });
      for (const [instanceId] of saved) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
          thread_id: instanceId,
          project_id: "project",
          title: instanceId,
          default_provider: instanceId,
          provider_instance_id: instanceId,
          runtime_mode: "full-access",
          interaction_mode: "default",
          created_at: at,
          updated_at: at,
          payload_json: JSON.stringify({
            id: instanceId,
            providerInstanceId: instanceId,
            modelSelection: selection(instanceId),
          }),
        })}`;
        yield* sql`INSERT INTO scheduled_tasks ${sql.insert(task(instanceId))}`;
        yield* sql`INSERT INTO scheduled_task_webhook_pending ${sql.insert({
          delivery_id: instanceId,
          task_id: instanceId,
          coalesce_key: "key",
          due_at: 0,
          task_json: JSON.stringify({ id: instanceId, modelSelection: selection(instanceId) }),
          request_json: "{}",
          delivery_ids_json: "[]",
        })}`;
        yield* sql`INSERT INTO projection_projects ${sql.insert({
          project_id: instanceId,
          title: "project",
          workspace_root: `/${instanceId}`,
          scripts_json: "[]",
          created_at: at,
          updated_at: at,
          default_model_selection_json: JSON.stringify(selection(instanceId)),
        })}`;
      }
      // The picker can move ahead of the instance the thread last ran on.
      yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
        thread_id: "picked",
        project_id: "project",
        title: "picked",
        default_provider: "codex_work",
        provider_instance_id: "codex_work",
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_at: at,
        updated_at: at,
        payload_json: JSON.stringify({
          id: "picked",
          providerInstanceId: "codex_work",
          modelSelection: selection(route),
        }),
      })}`;
      for (const [ordinal, status] of ["completed", "queued"].entries()) {
        yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
          run_id: status,
          thread_id: route,
          ordinal,
          provider: route,
          provider_instance_id: route,
          status,
          requested_at: at,
          payload_json: JSON.stringify({
            id: status,
            status,
            providerInstanceId: route,
            modelSelection: selection(route),
          }),
        })}`;
        yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
          attempt_id: status,
          thread_id: route,
          run_id: status,
          attempt_ordinal: 1,
          root_node_id: "node",
          provider: route,
          provider_instance_id: route,
          provider_thread_id: status,
          status: "pending",
          payload_json: JSON.stringify({ id: status, providerInstanceId: route }),
        })}`;
        // A started conversation has a native ref. The queue's placeholder has none.
        const nativeThreadRef = status === "completed" ? { nativeId: "native" } : null;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert({
          provider_thread_id: status,
          thread_id: route,
          provider: route,
          driver: "codex",
          provider_instance_id: route,
          status: status === "completed" ? "idle" : "not_loaded",
          first_run_ordinal: status === "completed" ? 0 : null,
          updated_at: at,
          payload_json: JSON.stringify({ id: status, providerInstanceId: route, nativeThreadRef }),
        })}`;
      }

      yield* runMigrations({ toMigrationInclusive: 95 });

      const threads = yield* sql<{ readonly saved: string; readonly current: string }>`
        SELECT thread_id AS saved,
          default_provider || '|' || provider_instance_id || '|' ||
          json_extract(payload_json, '$.providerInstanceId') || '|' ||
          json_extract(payload_json, '$.modelSelection.instanceId') AS current
        FROM orchestration_v2_projection_threads
      `;
      assert.sameDeepMembers(
        threads.map((row) => [row.saved, row.current]),
        [
          ...saved.map(([from, to]) => [from, [to, to, to, to].join("|")]),
          ["picked", "codex_work|codex_work|codex_work|codex"],
        ],
      );
      const selections = yield* sql<{ readonly saved: string; readonly current: string }>`
        SELECT task_id AS saved, json_extract(model_selection_json, '$.instanceId') AS current
        FROM scheduled_tasks
        UNION ALL
        SELECT delivery_id, json_extract(task_json, '$.modelSelection.instanceId')
        FROM scheduled_task_webhook_pending
        UNION ALL
        SELECT project_id, json_extract(default_model_selection_json, '$.instanceId')
        FROM projection_projects
      `;
      assert.sameDeepMembers(
        selections.map((row) => [row.saved, row.current]),
        [...saved, ...saved, ...saved].map(([from, to]) => [from, to]),
      );
      const work = yield* sql<{ readonly row: string; readonly current: string }>`
        SELECT 'run ' || status AS row,
          provider || '|' || provider_instance_id || '|' ||
          json_extract(payload_json, '$.providerInstanceId') || '|' ||
          json_extract(payload_json, '$.modelSelection.instanceId') AS current
        FROM orchestration_v2_projection_runs
        UNION ALL
        SELECT 'attempt ' || attempt_id,
          provider || '|' || provider_instance_id || '|' ||
          json_extract(payload_json, '$.providerInstanceId')
        FROM orchestration_v2_projection_run_attempts
        UNION ALL
        SELECT 'provider thread ' || provider_thread_id,
          provider || '|' || provider_instance_id || '|' ||
          json_extract(payload_json, '$.providerInstanceId')
        FROM orchestration_v2_projection_provider_threads
      `;
      assert.sameDeepMembers(
        work.map((row) => [row.row, row.current]),
        [
          ["run completed", [route, route, route, route].join("|")],
          ["run queued", "codex|codex|codex|codex"],
          ["attempt completed", [route, route, route].join("|")],
          ["attempt queued", "codex|codex|codex"],
          ["provider thread completed", [route, route, route].join("|")],
          ["provider thread queued", "codex|codex|codex"],
        ],
      );
    }),
  );
});
