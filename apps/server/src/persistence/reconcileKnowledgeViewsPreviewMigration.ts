import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import RetireInferenceRouteInstances from "./Migrations/095_RetireInferenceRouteInstances.ts";

// The recall and inference previews both used 95; the recall views table is unchanged.
export const reconcileKnowledgeViewsPreviewMigration = Effect.fn(
  "reconcileKnowledgeViewsPreviewMigration",
)(function* (manifest: ReadonlyArray<readonly [number, string]>) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 55`;
      const recorded = new Map(history.map((row) => [row.migration_id, row.name]));
      if (recorded.get(95) !== "ProjectKnowledgeViews") return [];

      const expected = new Map(manifest.filter(([id]) => id >= 55 && id < 95));
      expected.set(95, "ProjectKnowledgeViews");
      if (
        [...expected].some(([id, name]) => recorded.get(id) !== name) ||
        history.some((row) => expected.get(row.migration_id) !== row.name)
      ) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot reconcile recall preview with unexpected migration history.",
        });
      }
      const tablesWithViews = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_knowledge_views'
      `;
      const columns = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(project_knowledge_views)`;
      const names = ["project_id", "thread_id", "fact_id"];
      if (
        !tablesWithViews[0]?.sql.toUpperCase().includes("WITHOUT ROWID") ||
        columns.length !== names.length ||
        columns.some(
          (column, index) =>
            column.name !== names[index] ||
            column.type.toUpperCase() !== "TEXT" ||
            column.notnull !== 1 ||
            column.pk !== index + 1,
        )
      ) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot reconcile recall preview with an unexpected views schema.",
        });
      }

      yield* RetireInferenceRouteInstances;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 96 WHERE migration_id = 95`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (95, 'RetireInferenceRouteInstances')
      `;
      return [[95, "RetireInferenceRouteInstances"]] as const;
    }),
  );
});
