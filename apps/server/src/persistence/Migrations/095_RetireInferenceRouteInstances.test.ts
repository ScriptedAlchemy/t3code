import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const at = "2026-11-10T00:00:00.000Z";
const route = "inference_codex_1ce3f6740fb26811";

layer("095_RetireInferenceRouteInstances", (it) => {
  it.effect("preserves selections while settings migrate their recorded destinations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 94 });
      const saved = [
        [route, route],
        ["inference_claudeAgent_1ce3f6740fb26811", "inference_claudeAgent_1ce3f6740fb26811"],
        ["pool_codex", "pool_codex"],
        ["pool_claudeAgent", "pool_claudeAgent"],
        // User-defined names remain unchanged too.
        ["inference_codex_host", "inference_codex_host"],
        ["codex_work", "codex_work"],
        ["pool_cursor", "pool_cursor"],
      ] as const;
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
            modelSelection: { instanceId, model: "gpt-6" },
          }),
        })}`;
        yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
          task_id: instanceId,
          title: "task",
          prompt: "Run",
          enabled: 1,
          schedule_json: '{"type":"interval","everyMs":60000}',
          project_id: "project",
          thread_id: null,
          workspace_strategy_json: '{"type":"root"}',
          model_selection_json: JSON.stringify({ instanceId, model: "gpt-6" }),
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
        })}`;
      }
      for (const [ordinal, status] of ["completed", "queued"].entries()) {
        yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
          run_id: status,
          thread_id: route,
          ordinal,
          provider: "codex",
          provider_instance_id: route,
          status,
          requested_at: at,
          payload_json: JSON.stringify({
            id: status,
            status,
            providerInstanceId: route,
            modelSelection: { instanceId: route, model: "gpt-6" },
          }),
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
        saved.map(([from, to]) => [from, [to, to, to, to].join("|")]),
      );
      const tasks = yield* sql<{ readonly saved: string; readonly current: string }>`
        SELECT task_id AS saved, json_extract(model_selection_json, '$.instanceId') AS current
        FROM scheduled_tasks
      `;
      assert.sameDeepMembers(
        tasks.map((row) => [row.saved, row.current]),
        saved.map(([from, to]) => [from, to]),
      );
      const runs = yield* sql<{ readonly status: string; readonly current: string }>`
        SELECT status,
          provider_instance_id || '|' || json_extract(payload_json, '$.providerInstanceId') ||
          '|' || json_extract(payload_json, '$.modelSelection.instanceId') AS current
        FROM orchestration_v2_projection_runs ORDER BY status
      `;
      assert.deepStrictEqual(
        runs.map((row) => [row.status, row.current]),
        [
          ["completed", [route, route, route].join("|")],
          ["queued", [route, route, route].join("|")],
        ],
      );
    }),
  );
});
