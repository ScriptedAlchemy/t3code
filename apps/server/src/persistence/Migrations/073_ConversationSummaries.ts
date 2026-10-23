import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Summary rows are immutable; the id is derived from the thread and its exact sources, so a
  // retried pass lands on the same row. Source text is never stored here, only identities and
  // digests inside payload_json.
  yield* sql`
    CREATE TABLE conversation_summaries (
      summary_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      first_source_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX conversation_summaries_thread
    ON conversation_summaries(thread_id, first_source_at, summary_id)
  `;
  // The latest background pass per thread, so clients can tell off, waiting and failed apart.
  yield* sql`
    CREATE TABLE conversation_summary_passes (
      thread_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});
