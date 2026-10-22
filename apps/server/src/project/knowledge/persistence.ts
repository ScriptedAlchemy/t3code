import {
  ActiveProjectFact,
  KnowledgeFactSource,
  ProjectFact,
  ProjectFactId,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const FactRow = Schema.Struct({
  ...ActiveProjectFact.fields,
  content: Schema.NullOr(Schema.String),
  status: Schema.Literals(["proposed", "confirmed", "forgotten"]),
  forgottenAt: Schema.NullOr(Schema.String),
  entities: Schema.fromJsonString(ActiveProjectFact.fields.entities),
  tags: Schema.fromJsonString(ActiveProjectFact.fields.tags),
  sources: Schema.fromJsonString(Schema.Array(KnowledgeFactSource)),
});
const encodeLabels = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeSources = Schema.encodeSync(Schema.fromJsonString(Schema.Array(KnowledgeFactSource)));
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(FactRow));
const decodeProjectFacts = Schema.decodeUnknownEffect(Schema.Array(ProjectFact));
const decodeFacts = Effect.fn("ProjectKnowledgeStore.decodeFacts")(function* (rows: unknown) {
  return yield* decodeProjectFacts(yield* decodeRows(rows));
});

export const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql`
    id, project_id AS "projectId", status, revision, content,
    entities_json AS entities, tags_json AS tags, kind, trust,
    retrieval_count AS "retrievalCount", created_at AS "createdAt",
    updated_at AS "updatedAt", forgotten_at AS "forgottenAt", sources_json AS sources
  `;
  const find = Effect.fn("ProjectKnowledgeStore.find")(function* (
    projectId: ProjectId,
    id: ProjectFactId,
  ) {
    const rows =
      yield* sql`SELECT ${columns} FROM project_knowledge_facts WHERE project_id = ${projectId} AND id = ${id}`;
    return (yield* decodeFacts(rows))[0] ?? null;
  });
  const list = Effect.fn("ProjectKnowledgeStore.list")(function* (
    projectId: ProjectId,
    status: ProjectFact["status"],
    afterId: string | null,
    limit: number,
  ) {
    return yield* sql`
      SELECT ${columns} FROM project_knowledge_facts
      WHERE project_id = ${projectId} AND status = ${status}
        AND (${afterId} IS NULL OR id > ${afterId})
      ORDER BY id ASC LIMIT ${limit}
    `.pipe(Effect.flatMap(decodeFacts));
  });
  const insert = Effect.fn("ProjectKnowledgeStore.insert")(function* (fact: ProjectFact) {
    yield* sql`INSERT INTO project_knowledge_facts (
      id, project_id, status, revision, content, entities_json, tags_json, kind, trust,
      retrieval_count, created_at, updated_at, forgotten_at, sources_json
    ) VALUES (
      ${fact.id}, ${fact.projectId}, ${fact.status}, ${fact.revision}, ${fact.content},
      ${encodeLabels(fact.entities)}, ${encodeLabels(fact.tags)}, ${fact.kind}, ${fact.trust},
      ${fact.retrievalCount}, ${fact.createdAt}, ${fact.updatedAt}, ${fact.forgottenAt}, ${encodeSources(fact.sources)}
    )`;
  });
  const update = Effect.fn("ProjectKnowledgeStore.update")(function* (
    fact: ProjectFact,
    expectedRevision: number,
  ) {
    const changed = yield* sql`UPDATE project_knowledge_facts SET
      status = ${fact.status}, revision = ${fact.revision}, content = ${fact.content},
      entities_json = ${encodeLabels(fact.entities)}, tags_json = ${encodeLabels(fact.tags)},
      kind = ${fact.kind}, trust = ${fact.trust}, updated_at = ${fact.updatedAt},
      forgotten_at = ${fact.forgottenAt}, sources_json = ${encodeSources(fact.sources)}
      WHERE id = ${fact.id} AND project_id = ${fact.projectId} AND revision = ${expectedRevision}
      RETURNING id`;
    return changed.length === 1;
  });
  const receipt = Effect.fn("ProjectKnowledgeStore.receipt")(function* (commandId: string) {
    const rows = yield* sql<{ projectId: string; factId: string | null; digest: string }>`
      SELECT project_id AS "projectId", fact_id AS "factId", request_digest AS digest
      FROM project_knowledge_commands WHERE command_id = ${commandId}`;
    return rows[0] ?? null;
  });
  const record = Effect.fn("ProjectKnowledgeStore.record")(function* (
    commandId: string,
    projectId: ProjectId,
    factId: ProjectFactId | null,
    digest: string,
  ) {
    yield* sql`INSERT INTO project_knowledge_commands (command_id, project_id, fact_id, request_digest)
      VALUES (${commandId}, ${projectId}, ${factId}, ${digest})`;
  });
  return { find, list, insert, update, receipt, record };
});
