import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ShellStopRequestIndex from "./Migrations/078_ShellStopRequestIndex.ts";
import ThreadMessageSearch from "./Migrations/079_ThreadMessageSearch.ts";
import ProjectIntelligenceAndCrossEnvironment from "./Migrations/080_ProjectIntelligenceAndCrossEnvironment.ts";

// Preview builds used a conflicting 79, split 80–83, and an earlier combined 80.
// Complete their schema before replacing only known obsolete migration receipts.
export const reconcileProjectKnowledgePreviewMigration = Effect.fn(
  "reconcileProjectKnowledgePreviewMigration",
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
        readonly created_at: string;
      }>`
        SELECT migration_id, name, created_at FROM effect_sql_migrations
        WHERE migration_id >= 55 ORDER BY migration_id
      `;
      const recorded = new Map(history.map((row) => [row.migration_id, row.name]));
      if (recorded.get(80) === "ProjectIntelligenceAndCrossEnvironment") {
        const peerColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(peer_environment_links)`;
        const waitingIndex = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'index'
            AND name = 'orchestration_v2_projection_turn_items_waiting_link_idx'
        `;
        if (peerColumns.some((column) => column.name === "fenced") && waitingIndex.length > 0) {
          return [];
        }
        const expected = new Map(manifest.filter(([id]) => id >= 55 && id <= 80));
        if (
          [...expected].some(([id, name]) => recorded.get(id) !== name) ||
          history.some((row) => expected.get(row.migration_id) !== row.name)
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot complete project preview with unexpected migration history.",
          });
        }
        // The published combined preview already recorded 80. Preserve its receipt,
        // delivery data, and any now-unused client-bridge routing table.
        yield* ProjectIntelligenceAndCrossEnvironment;
        return [];
      }
      const legacy = recorded.get(79) === "ProjectKnowledgeNativeDelivery";
      const split = new Map([
        [80, "ProjectKnowledgeNativeDelivery"],
        [81, "ProjectKnowledgeDeliveryBudget"],
        [82, "ProjectLoomWindowItems"],
        [83, "CrossEnvironmentLaunches"],
      ]);
      if (!legacy && !history.some((row) => split.get(row.migration_id) === row.name)) return [];
      const base = manifest.filter(([id]) => id >= 55 && id < (legacy ? 78 : 80));
      const expected = new Map<number, string>(base);
      if (legacy) {
        expected.set(78, "ShellStopRequestIndex");
        expected.set(79, "ProjectKnowledgeNativeDelivery");
        expected.set(80, "ProjectKnowledgeDeliveryBudget");
      } else {
        for (const [id, name] of split) expected.set(id, name);
      }
      if (
        base.some(([id, name]) => recorded.get(id) !== name) ||
        history.some((row) => expected.get(row.migration_id) !== row.name) ||
        (!legacy &&
          ((recorded.has(81) && !recorded.has(80)) ||
            (recorded.has(82) && (!recorded.has(80) || !recorded.has(81)))))
      ) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot consolidate project preview with unexpected migration history.",
        });
      }

      const firstPreviewId = legacy ? 79 : 80;
      const firstPreview = history.find((row) => row.migration_id >= firstPreviewId);
      if (firstPreview === undefined) return [];
      const executed: Array<readonly [number, string]> = [];
      if (legacy && !recorded.has(78)) {
        yield* ShellStopRequestIndex;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name) VALUES (78, 'ShellStopRequestIndex')
        `;
        executed.push([78, "ShellStopRequestIndex"]);
      }
      if (legacy) yield* ThreadMessageSearch;
      yield* ProjectIntelligenceAndCrossEnvironment;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${firstPreviewId}`;
      if (legacy) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name) VALUES (79, 'ThreadMessageSearch')
        `;
        executed.push([79, "ThreadMessageSearch"]);
      }
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (80, 'ProjectIntelligenceAndCrossEnvironment', ${firstPreview.created_at})
      `;
      executed.push([80, "ProjectIntelligenceAndCrossEnvironment"]);
      return executed;
    }),
  );
});
