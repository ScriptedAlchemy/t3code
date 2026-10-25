import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ShellStopRequestIndex from "./Migrations/078_ShellStopRequestIndex.ts";
import ThreadMessageSearch from "./Migrations/079_ThreadMessageSearch.ts";

// Knowledge previews used 79 before main assigned it to message search. Preserve
// their receipts and timestamps while filling the index migrations they skipped.
export const reconcileProjectKnowledgePreviewMigration = Effect.fn(
  "reconcileProjectKnowledgePreviewMigration",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 78
      `;
      if (
        !history.some(
          (row) => row.migration_id === 79 && row.name === "ProjectKnowledgeNativeDelivery",
        )
      ) {
        return [];
      }
      const expected = new Map([
        [78, "ShellStopRequestIndex"],
        [79, "ProjectKnowledgeNativeDelivery"],
        [80, "ProjectKnowledgeDeliveryBudget"],
      ]);
      if (history.some((row) => expected.get(row.migration_id) !== row.name)) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade project knowledge preview with unexpected later migrations.",
        });
      }

      // Move the later entry first so neither update collides with a primary key.
      yield* sql`
        UPDATE effect_sql_migrations SET migration_id = 81
        WHERE migration_id = 80 AND name = 'ProjectKnowledgeDeliveryBudget'
      `;
      yield* sql`
        UPDATE effect_sql_migrations SET migration_id = 80
        WHERE migration_id = 79 AND name = 'ProjectKnowledgeNativeDelivery'
      `;
      const executed: Array<readonly [number, string]> = [];
      if (!history.some((row) => row.migration_id === 78)) {
        yield* ShellStopRequestIndex;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name) VALUES (78, 'ShellStopRequestIndex')
        `;
        executed.push([78, "ShellStopRequestIndex"]);
      }
      yield* ThreadMessageSearch;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (79, 'ThreadMessageSearch')
      `;
      executed.push([79, "ThreadMessageSearch"]);
      return executed;
    }),
  );
});
