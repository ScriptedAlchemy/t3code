import {
  ActiveProjectFact,
  CommandId,
  KnowledgeDigest,
  KnowledgeScore,
  NonNegativeInt,
  PositiveInt,
  KnowledgeFactSource,
  KnowledgeOrigin,
  ProjectFact,
  ProjectFactId,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const SearchRanking = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({ factId: ProjectFactId, revision: PositiveInt, score: KnowledgeScore }),
  ).check(Schema.isMaxLength(1000)),
  coverage: Schema.Literals(["complete", "partial"]),
});
const SearchReceipt = Schema.Struct({
  rootRequestId: CommandId,
  queryDigest: KnowledgeDigest,
  ranking: Schema.NullOr(SearchRanking),
  positions: Schema.Array(NonNegativeInt).check(Schema.isMaxLength(50)),
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type SearchReceipt = typeof SearchReceipt.Type;
const ReceiptRow = Schema.Struct({
  projectId: ProjectId,
  factId: Schema.NullOr(ProjectFactId),
  digest: KnowledgeDigest,
  search: Schema.NullOr(Schema.fromJsonString(SearchReceipt)),
});
const decodeReceipts = Schema.decodeUnknownEffect(Schema.Array(ReceiptRow));
const encodeSearchReceipt = Schema.encodeSync(Schema.fromJsonString(SearchReceipt));

const FactRow = Schema.Struct({
  ...ActiveProjectFact.fields,
  content: Schema.NullOr(Schema.String),
  status: Schema.Literals(["proposed", "confirmed", "forgotten"]),
  forgottenAt: Schema.NullOr(Schema.String),
  entities: Schema.fromJsonString(ActiveProjectFact.fields.entities),
  tags: Schema.fromJsonString(ActiveProjectFact.fields.tags),
  origin: Schema.fromJsonString(KnowledgeOrigin),
  sources: Schema.fromJsonString(Schema.Array(KnowledgeFactSource)),
});
const encodeOrigin = Schema.encodeSync(Schema.fromJsonString(KnowledgeOrigin));
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
    updated_at AS "updatedAt", forgotten_at AS "forgottenAt", sources_json AS sources, origin_json AS origin
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
      retrieval_count, created_at, updated_at, forgotten_at, sources_json, origin_json
    ) VALUES (
      ${fact.id}, ${fact.projectId}, ${fact.status}, ${fact.revision}, ${fact.content},
      ${encodeLabels(fact.entities)}, ${encodeLabels(fact.tags)}, ${fact.kind}, ${fact.trust},
      ${fact.retrievalCount}, ${fact.createdAt}, ${fact.updatedAt}, ${fact.forgottenAt}, ${encodeSources(fact.sources)}, ${encodeOrigin(fact.origin)}
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
      forgotten_at = ${fact.forgottenAt}, sources_json = ${encodeSources(fact.sources)}, origin_json = ${encodeOrigin(fact.origin)}
      WHERE id = ${fact.id} AND project_id = ${fact.projectId} AND revision = ${expectedRevision}
      RETURNING id`;
    return changed.length === 1;
  });
  const receipt = Effect.fn("ProjectKnowledgeStore.receipt")(function* (commandId: string) {
    const rows = yield* sql`
      SELECT project_id AS "projectId", fact_id AS "factId", request_digest AS digest, search_json AS search
      FROM project_knowledge_commands WHERE command_id = ${commandId}`;
    return (yield* decodeReceipts(rows))[0] ?? null;
  });
  const record = Effect.fn("ProjectKnowledgeStore.record")(function* (
    commandId: string,
    projectId: ProjectId,
    factId: ProjectFactId | null,
    digest: string,
    search: SearchReceipt | null = null,
  ) {
    yield* sql`INSERT INTO project_knowledge_commands (command_id, project_id, fact_id, request_digest, search_json)
      VALUES (${commandId}, ${projectId}, ${factId}, ${digest}, ${search === null ? null : encodeSearchReceipt(search)})`;
  });
  const findMany = Effect.fn("ProjectKnowledgeStore.findMany")(function* (
    projectId: ProjectId,
    ids: ReadonlyArray<ProjectFactId>,
  ) {
    if (ids.length === 0) return [];
    return yield* sql`SELECT ${columns} FROM project_knowledge_facts WHERE project_id = ${projectId} AND ${sql.in("id", ids)}`.pipe(
      Effect.flatMap(decodeFacts),
    );
  });
  const candidates = Effect.fn("ProjectKnowledgeStore.candidates")(function* (
    projectId: ProjectId,
    terms: ReadonlyArray<string>,
    entities: ReadonlyArray<string>,
    minTrust: number,
  ) {
    const ftsQuery = terms
      .map((term) => `"${term.replaceAll('"', '""')}"${Buffer.byteLength(term) >= 4 ? "*" : ""}`)
      .join(" OR ");
    const lexical =
      ftsQuery === ""
        ? []
        : yield* sql<{ id: ProjectFactId; rank: number }>`
      SELECT f.id, bm25(project_knowledge_fts) AS rank
      FROM project_knowledge_fts JOIN project_knowledge_facts f ON f.rowid = project_knowledge_fts.rowid
      WHERE project_knowledge_fts MATCH ${ftsQuery} AND f.project_id = ${projectId}
        AND f.status IN ('confirmed', 'proposed') AND f.trust >= ${minTrust}
      ORDER BY rank ASC, f.updated_at DESC, f.id ASC LIMIT 1001`;
    const byEntity =
      entities.length === 0
        ? []
        : yield* sql<{ id: ProjectFactId }>`
      SELECT id FROM project_knowledge_facts f WHERE project_id = ${projectId}
        AND status IN ('confirmed', 'proposed') AND trust >= ${minTrust}
        AND EXISTS (SELECT 1 FROM json_each(f.entities_json) e WHERE ${sql.or(entities.map((entity) => sql`lower(e.value) = ${entity}`))})
      ORDER BY updated_at DESC, id ASC LIMIT 1001`;
    const newest = yield* sql<{ id: ProjectFactId }>`SELECT id FROM project_knowledge_facts
      WHERE project_id = ${projectId} AND status IN ('confirmed', 'proposed') AND trust >= ${minTrust}
      ORDER BY updated_at DESC, id ASC LIMIT 1001`;
    const ids = [...new Set([...lexical, ...byEntity, ...newest].map((row) => row.id))];
    return {
      facts: yield* findMany(projectId, ids.slice(0, 1000)),
      ranks: new Map(lexical.map((row) => [row.id, row.rank])),
      partial: ids.length > 1000,
    };
  });
  const recordRetrieval = Effect.fn("ProjectKnowledgeStore.recordRetrieval")(function* (
    projectId: ProjectId,
    ids: ReadonlyArray<ProjectFactId>,
  ) {
    if (ids.length === 0) return;
    yield* sql`UPDATE project_knowledge_facts SET retrieval_count = retrieval_count + 1
      WHERE project_id = ${projectId} AND status IN ('confirmed', 'proposed') AND ${sql.in("id", ids)}`;
  });
  return { find, findMany, list, insert, update, receipt, record, candidates, recordRetrieval };
});
