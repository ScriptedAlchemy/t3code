import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_knowledge_deliveries ADD COLUMN provider_thread_id TEXT`;
  yield* sql`ALTER TABLE project_knowledge_deliveries ADD COLUMN native_thread_id TEXT`;
});
