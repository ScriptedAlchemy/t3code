import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const locations = [
    ["projection_threads", "model_selection_json", "$.options", null],
    ["projection_projects", "default_model_selection_json", "$.options", null],
    [
      "orchestration_events",
      "payload_json",
      "$.modelSelection.options",
      ["thread.created", "thread.meta-updated", "thread.turn-start-requested"],
    ],
    [
      "orchestration_events",
      "payload_json",
      "$.defaultModelSelection.options",
      ["project.created", "project.meta-updated"],
    ],
  ] as const;

  // Migration 026 could lose SQLite's JSON subtype across its scalar subqueries.
  for (const [table, column, property, eventTypes] of locations) {
    yield* sql`
      UPDATE ${sql(table)}
      SET ${sql(column)} = json_replace(
        ${sql(column)}, ${property}, json(json_extract(${sql(column)}, ${property}))
      )
      WHERE ${eventTypes === null ? sql`1` : sql.in("event_type", eventTypes)}
        AND CASE WHEN json_valid(${sql(column)}) THEN
          CASE WHEN json_type(${sql(column)}, ${property}) = 'text' THEN
            CASE WHEN json_valid(json_extract(${sql(column)}, ${property})) THEN
              json_type(json_extract(${sql(column)}, ${property})) = 'array'
            END
          END
        END
    `;
  }
});
