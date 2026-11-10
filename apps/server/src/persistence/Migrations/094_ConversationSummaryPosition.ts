import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A condensed summary's first source is another summary, so the timestamp alone cannot order
  // it. The column now holds the full conversation-order key, which still begins with that time.
  yield* sql`ALTER TABLE conversation_summaries RENAME COLUMN first_source_at TO position`;
});
