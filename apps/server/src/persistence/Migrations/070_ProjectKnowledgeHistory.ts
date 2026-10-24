import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Supersession is a link, not a status: the replaced fact keeps its lifecycle status and
  // content, and recall filters on the link.
  yield* sql`ALTER TABLE project_knowledge_facts ADD COLUMN supersedes_id TEXT`;
  yield* sql`ALTER TABLE project_knowledge_facts ADD COLUMN superseded_by_id TEXT`;
  // Append-only, except that forgetting a fact erases the bodies and citations of its
  // earlier revisions too.
  yield* sql`
    CREATE TABLE project_knowledge_fact_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      event TEXT NOT NULL CHECK (event IN (
        'baseline', 'created', 'edited', 'confirmed', 'forgotten', 'feedback', 'superseded'
      )),
      actor_json TEXT NOT NULL,
      content_digest TEXT,
      content TEXT,
      sources_json TEXT NOT NULL,
      trust_before REAL,
      trust_after REAL NOT NULL,
      helpful INTEGER,
      related_fact_id TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX project_knowledge_fact_history_fact ON project_knowledge_fact_history(project_id, fact_id, sequence)`;
  yield* sql`CREATE INDEX project_knowledge_fact_history_feedback ON project_knowledge_fact_history(project_id, event)`;
  yield* sql`
    INSERT INTO project_knowledge_fact_history (
      project_id, fact_id, revision, event, actor_json, content_digest, content, sources_json,
      trust_before, trust_after, helpful, related_fact_id, created_at
    )
    SELECT project_id, id, revision, 'baseline', origin_json, NULL, content, sources_json,
      NULL, trust, NULL, NULL, updated_at
    FROM project_knowledge_facts ORDER BY created_at, id
  `;
});
