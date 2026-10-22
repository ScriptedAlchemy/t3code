import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE project_knowledge_facts (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'forgotten')),
      revision INTEGER NOT NULL CHECK (revision > 0),
      content TEXT,
      entities_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      kind TEXT NOT NULL,
      trust REAL NOT NULL CHECK (trust >= 0 AND trust <= 1),
      retrieval_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      forgotten_at TEXT,
      sources_json TEXT NOT NULL,
      CHECK (status != 'forgotten' OR
        (content IS NULL AND entities_json = '[]' AND tags_json = '[]' AND sources_json = '[]'))
    )
  `;
  yield* sql`CREATE INDEX project_knowledge_facts_project ON project_knowledge_facts(project_id, status, id)`;
  yield* sql`
    CREATE VIRTUAL TABLE project_knowledge_fts USING fts5(
      content, entities_json, tags_json, content='project_knowledge_facts', content_rowid='rowid'
    )
  `;
  yield* sql`
    CREATE TRIGGER project_knowledge_insert AFTER INSERT ON project_knowledge_facts BEGIN
      INSERT INTO project_knowledge_fts(rowid, content, entities_json, tags_json)
      VALUES (new.rowid, new.content, new.entities_json, new.tags_json);
    END
  `;
  yield* sql`
    CREATE TRIGGER project_knowledge_delete AFTER DELETE ON project_knowledge_facts BEGIN
      INSERT INTO project_knowledge_fts(project_knowledge_fts, rowid, content, entities_json, tags_json)
      VALUES ('delete', old.rowid, old.content, old.entities_json, old.tags_json);
    END
  `;
  yield* sql`
    CREATE TRIGGER project_knowledge_update AFTER UPDATE OF content, entities_json, tags_json ON project_knowledge_facts BEGIN
      INSERT INTO project_knowledge_fts(project_knowledge_fts, rowid, content, entities_json, tags_json)
      VALUES ('delete', old.rowid, old.content, old.entities_json, old.tags_json);
      INSERT INTO project_knowledge_fts(rowid, content, entities_json, tags_json)
      VALUES (new.rowid, new.content, new.entities_json, new.tags_json);
    END
  `;
  yield* sql`
    CREATE TABLE project_knowledge_commands (
      command_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      fact_id TEXT,
      request_digest TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});
