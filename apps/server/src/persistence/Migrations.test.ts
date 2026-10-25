import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import ProjectKnowledgeNativeDelivery from "./Migrations/080_ProjectKnowledgeNativeDelivery.ts";
import ProjectKnowledgeDeliveryBudget from "./Migrations/081_ProjectKnowledgeDeliveryBudget.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("adds upstream indexes to an existing fork database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 77 });
      const before = yield* history;
      assert.deepStrictEqual(yield* runMigrations(), [
        [78, "ShellStopRequestIndex"],
        [79, "ThreadMessageSearch"],
        [80, "ProjectKnowledgeNativeDelivery"],
        [81, "ProjectKnowledgeDeliveryBudget"],
        [82, "ProjectLoomWindowItems"],
      ]);
      assert.deepStrictEqual((yield* history).slice(0, before.length), before);
      const indexes = yield* sql`
        SELECT name FROM sqlite_master
        WHERE name = 'orchestration_v2_projection_turn_items_stop_request_idx'
      `;
      assert.lengthOf(indexes, 1);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([false, true])(
    "preserves knowledge preview receipts when reconciling migration ids (budget: %s)",
    (hasBudget) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 77 });
        yield* ProjectKnowledgeNativeDelivery;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          VALUES (79, 'ProjectKnowledgeNativeDelivery', '2026-10-23 01:00:00')
        `;
        if (hasBudget) {
          yield* ProjectKnowledgeDeliveryBudget;
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name, created_at)
            VALUES (80, 'ProjectKnowledgeDeliveryBudget', '2026-10-23 02:00:00')
          `;
        }
        yield* sql`
          INSERT INTO project_knowledge_deliveries (
            attempt_id, run_id, thread_id, message_id, project_id, provider_instance_id,
            status, items_json, omissions_json, created_at, updated_at,
            provider_thread_id, native_thread_id
          ) VALUES (
            'attempt', 'run', 'thread', 'message', 'project', 'provider',
            'sent', '[]', '[]', '2026-10-23', '2026-10-23', 'provider-thread', 'native-thread'
          )
        `;
        if (hasBudget) {
          yield* sql`UPDATE project_knowledge_deliveries SET budget_json = '{"capacity":128000}'`;
        }

        yield* runMigrations();

        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.deepStrictEqual(
          yield* sql`SELECT provider_thread_id, native_thread_id, budget_json FROM project_knowledge_deliveries`,
          [
            {
              provider_thread_id: "provider-thread",
              native_thread_id: "native-thread",
              budget_json: hasBudget ? '{"capacity":128000}' : null,
            },
          ],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 80`,
          [{ created_at: "2026-10-23 01:00:00" }],
        );
        assert.lengthOf(
          yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_turn_items_stop_request_idx'`,
          1,
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("does not rewrite a knowledge preview with unexpected later migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 77 });
      yield* ProjectKnowledgeNativeDelivery;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (79, 'ProjectKnowledgeNativeDelivery'), (80, 'UnrelatedMigration')
      `;
      const before = yield* history;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
