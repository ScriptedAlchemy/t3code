import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A condensed summary's first source is another summary, so the timestamp alone cannot order
  // it. The column now holds the full conversation-order key, which still begins with that time.
  yield* sql`ALTER TABLE conversation_summaries RENAME COLUMN first_source_at TO position`;
  // Rows written before this held only the time, which leaves of one split source share. Finish
  // the key as leafPosition builds it: source identity, padded offset, then the leaf depth mark.
  yield* sql`
    UPDATE conversation_summaries SET position = position || char(1)
      || CASE json_extract(payload_json, '$.sources[0].kind')
        WHEN 'message' THEN 'message:' || json_extract(payload_json, '$.sources[0].messageId')
        ELSE 'turn_item:' || json_extract(payload_json, '$.sources[0].itemId') END
      || char(1)
      || printf('%012d', coalesce(json_extract(payload_json, '$.sources[0].range.start'), 0))
      || char(1) || '99'
  `;
});
