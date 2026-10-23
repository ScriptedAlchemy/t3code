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
  ProjectFactHistoryEntry,
  ProjectFactId,
  ProjectId,
  ProjectKnowledgeDelivery,
  ProjectKnowledgeDeliveryItem,
  ProjectKnowledgeDeliveryOmission,
  type MessageId,
  type RunId,
  type ThreadId,
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

const HistoryRow = Schema.Struct({
  ...ProjectFactHistoryEntry.fields,
  actor: Schema.fromJsonString(KnowledgeOrigin),
  sources: Schema.fromJsonString(Schema.Array(KnowledgeFactSource)),
  helpful: Schema.NullOr(Schema.Number),
});
const decodeHistory = Schema.decodeUnknownEffect(Schema.Array(HistoryRow));
const decodeSources = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(KnowledgeFactSource)),
);
export type HistoryRecord = Omit<
  ProjectFactHistoryEntry,
  "sequence" | "sourceUnavailable" | "at" | "event"
> & {
  readonly projectId: ProjectId;
  readonly factId: ProjectFactId;
  readonly event: Exclude<ProjectFactHistoryEntry["event"], "baseline">;
  readonly at: string;
};

const DeliveryRow = Schema.Struct({
  ...ProjectKnowledgeDelivery.fields,
  items: Schema.fromJsonString(Schema.Array(ProjectKnowledgeDeliveryItem)),
  omissions: Schema.fromJsonString(Schema.Array(ProjectKnowledgeDeliveryOmission)),
});
const decodeDeliveries = Schema.decodeUnknownEffect(Schema.Array(DeliveryRow));
const decodeDeliveryItems = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ProjectKnowledgeDeliveryItem)),
);
const encodeDeliveryItems = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(ProjectKnowledgeDeliveryItem)),
);
const encodeDeliveryOmissions = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(ProjectKnowledgeDeliveryOmission)),
);

export const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql`
    id, project_id AS "projectId", status, revision, content,
    entities_json AS entities, tags_json AS tags, kind, trust,
    retrieval_count AS "retrievalCount", created_at AS "createdAt",
    updated_at AS "updatedAt", forgotten_at AS "forgottenAt", sources_json AS sources, origin_json AS origin,
    supersedes_id AS supersedes, superseded_by_id AS "supersededBy"
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
    // null lists proposed and confirmed together.
    status: ProjectFact["status"] | null,
    afterId: string | null,
    limit: number,
    includeSuperseded: boolean,
    onlyIds: ReadonlyArray<ProjectFactId> | null = null,
  ) {
    if (onlyIds !== null && onlyIds.length === 0) return [];
    return yield* sql`
      SELECT ${columns} FROM project_knowledge_facts
      WHERE project_id = ${projectId}
        AND ${status === null ? sql`status IN ('confirmed', 'proposed')` : sql`status = ${status}`}
        AND (${afterId} IS NULL OR id > ${afterId})
        AND (${includeSuperseded ? 1 : 0} = 1 OR status = 'forgotten' OR superseded_by_id IS NULL)
        AND ${onlyIds === null ? sql`1 = 1` : sql.in("id", onlyIds)}
      ORDER BY id ASC LIMIT ${limit}
    `.pipe(Effect.flatMap(decodeFacts));
  });
  const insert = Effect.fn("ProjectKnowledgeStore.insert")(function* (fact: ProjectFact) {
    yield* sql`INSERT INTO project_knowledge_facts (
      id, project_id, status, revision, content, entities_json, tags_json, kind, trust,
      retrieval_count, created_at, updated_at, forgotten_at, sources_json, origin_json,
      supersedes_id, superseded_by_id
    ) VALUES (
      ${fact.id}, ${fact.projectId}, ${fact.status}, ${fact.revision}, ${fact.content},
      ${encodeLabels(fact.entities)}, ${encodeLabels(fact.tags)}, ${fact.kind}, ${fact.trust},
      ${fact.retrievalCount}, ${fact.createdAt}, ${fact.updatedAt}, ${fact.forgottenAt}, ${encodeSources(fact.sources)}, ${encodeOrigin(fact.origin)},
      ${fact.supersedes ?? null}, ${fact.supersededBy ?? null}
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
      forgotten_at = ${fact.forgottenAt}, sources_json = ${encodeSources(fact.sources)}, origin_json = ${encodeOrigin(fact.origin)},
      supersedes_id = ${fact.supersedes ?? null}, superseded_by_id = ${fact.supersededBy ?? null}
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
    includeSuperseded: boolean,
  ) {
    const recallable = sql`f.status IN ('confirmed', 'proposed') AND f.trust >= ${minTrust}
      AND (${includeSuperseded ? 1 : 0} = 1 OR f.superseded_by_id IS NULL)`;
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
        AND ${recallable}
      ORDER BY rank ASC, f.updated_at DESC, f.id ASC LIMIT 1001`;
    const byEntity =
      entities.length === 0
        ? []
        : yield* sql<{ id: ProjectFactId }>`
      SELECT id FROM project_knowledge_facts f WHERE project_id = ${projectId}
        AND ${recallable}
        AND EXISTS (SELECT 1 FROM json_each(f.entities_json) e WHERE ${sql.or(entities.map((entity) => sql`lower(e.value) = ${entity}`))})
      ORDER BY updated_at DESC, id ASC LIMIT 1001`;
    const newest = yield* sql<{ id: ProjectFactId }>`SELECT id FROM project_knowledge_facts f
      WHERE project_id = ${projectId} AND ${recallable}
      ORDER BY updated_at DESC, id ASC LIMIT 1001`;
    const ids = [...new Set([...lexical, ...byEntity, ...newest].map((row) => row.id))];
    return {
      facts: yield* findMany(projectId, ids.slice(0, 1000)),
      ranks: new Map(lexical.map((row) => [row.id, row.rank])),
      partial: ids.length > 1000,
    };
  });
  // Lexical neighbours for duplicate and conflict hints; bounded so a write stays cheap.
  const similar = Effect.fn("ProjectKnowledgeStore.similar")(function* (
    projectId: ProjectId,
    terms: ReadonlyArray<string>,
    excludeIds: ReadonlyArray<ProjectFactId>,
  ) {
    const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    if (ftsQuery === "") return [];
    const rows = yield* sql<{ id: ProjectFactId }>`
      SELECT f.id FROM project_knowledge_fts JOIN project_knowledge_facts f ON f.rowid = project_knowledge_fts.rowid
      WHERE project_knowledge_fts MATCH ${ftsQuery} AND f.project_id = ${projectId}
        AND f.status IN ('confirmed', 'proposed') AND f.superseded_by_id IS NULL
        AND ${excludeIds.length === 0 ? sql`1 = 1` : sql`f.id NOT IN ${sql.in(excludeIds)}`}
      ORDER BY bm25(project_knowledge_fts) ASC, f.id ASC LIMIT 40`;
    return yield* findMany(
      projectId,
      rows.map((row) => row.id),
    );
  });
  const recordHistory = Effect.fn("ProjectKnowledgeStore.recordHistory")(function* (
    entry: HistoryRecord,
  ) {
    yield* sql`INSERT INTO project_knowledge_fact_history (
      project_id, fact_id, revision, event, actor_json, content_digest, content, sources_json,
      trust_before, trust_after, helpful, related_fact_id, created_at
    ) VALUES (
      ${entry.projectId}, ${entry.factId}, ${entry.revision}, ${entry.event},
      ${encodeOrigin(entry.actor)}, ${entry.contentDigest}, ${entry.content},
      ${encodeSources(entry.sources)}, ${entry.trustBefore}, ${entry.trustAfter},
      ${entry.helpful === null ? null : entry.helpful ? 1 : 0}, ${entry.relatedFactId}, ${entry.at}
    )`;
  });
  const eraseHistory = Effect.fn("ProjectKnowledgeStore.eraseHistory")(function* (
    projectId: ProjectId,
    factId: ProjectFactId,
  ) {
    yield* sql`UPDATE project_knowledge_fact_history SET content = NULL, sources_json = '[]'
      WHERE project_id = ${projectId} AND fact_id = ${factId}`;
  });
  const history = Effect.fn("ProjectKnowledgeStore.history")(function* (
    projectId: ProjectId,
    factId: ProjectFactId,
    limit: number,
  ) {
    const rows = yield* sql`
      SELECT sequence, event, revision, actor_json AS actor, created_at AS at,
        content_digest AS "contentDigest", content, sources_json AS sources,
        trust_before AS "trustBefore", trust_after AS "trustAfter", helpful,
        related_fact_id AS "relatedFactId", NULL AS "sourceUnavailable"
      FROM project_knowledge_fact_history
      WHERE project_id = ${projectId} AND fact_id = ${factId}
      ORDER BY sequence DESC LIMIT ${limit}`;
    return (yield* decodeHistory(rows))
      .map((row) => ({ ...row, helpful: row.helpful === null ? null : row.helpful !== 0 }))
      .toReversed();
  });
  const statusCounts = Effect.fn("ProjectKnowledgeStore.statusCounts")(function* (
    projectId: ProjectId,
    recallThreshold: number,
  ) {
    const [facts] = yield* sql<{
      readonly proposed: number;
      readonly confirmed: number;
      readonly superseded: number;
      readonly forgotten: number;
      readonly low: number;
      readonly guarded: number;
      readonly steady: number;
      readonly high: number;
      readonly belowRecallThreshold: number;
      readonly retrievals: number;
    }>`
      WITH recallable AS (
        SELECT trust FROM project_knowledge_facts
        WHERE project_id = ${projectId} AND status IN ('confirmed', 'proposed')
          AND superseded_by_id IS NULL
      )
      SELECT
        (SELECT COUNT(*) FROM project_knowledge_facts WHERE project_id = ${projectId}
          AND status = 'proposed' AND superseded_by_id IS NULL) AS proposed,
        (SELECT COUNT(*) FROM project_knowledge_facts WHERE project_id = ${projectId}
          AND status = 'confirmed' AND superseded_by_id IS NULL) AS confirmed,
        (SELECT COUNT(*) FROM project_knowledge_facts WHERE project_id = ${projectId}
          AND status != 'forgotten' AND superseded_by_id IS NOT NULL) AS superseded,
        (SELECT COUNT(*) FROM project_knowledge_facts WHERE project_id = ${projectId}
          AND status = 'forgotten') AS forgotten,
        (SELECT COUNT(*) FROM recallable WHERE trust < 0.25) AS low,
        (SELECT COUNT(*) FROM recallable WHERE trust >= 0.25 AND trust < 0.5) AS guarded,
        (SELECT COUNT(*) FROM recallable WHERE trust >= 0.5 AND trust < 0.75) AS steady,
        (SELECT COUNT(*) FROM recallable WHERE trust >= 0.75) AS high,
        (SELECT COUNT(*) FROM recallable WHERE trust < ${recallThreshold}) AS "belowRecallThreshold",
        (SELECT COALESCE(SUM(retrieval_count), 0) FROM project_knowledge_facts
          WHERE project_id = ${projectId} AND status != 'forgotten') AS retrievals`;
    const feedback = yield* sql<{ readonly helpful: number; readonly count: number }>`
      SELECT helpful, COUNT(*) AS count FROM project_knowledge_fact_history
      WHERE project_id = ${projectId} AND event = 'feedback' GROUP BY helpful`;
    return {
      ...facts!,
      helpful: feedback.find((row) => row.helpful === 1)?.count ?? 0,
      unhelpful: feedback.find((row) => row.helpful === 0)?.count ?? 0,
    };
  });
  /** Citations of active facts, for whole-project source checks. */
  const citedFacts = Effect.fn("ProjectKnowledgeStore.citedFacts")(function* (
    projectId: ProjectId,
    status: ProjectFact["status"] | null,
    includeSuperseded: boolean,
    limit: number,
  ) {
    const rows = yield* sql<{ readonly id: ProjectFactId; readonly sources: string }>`
      SELECT id, sources_json AS sources FROM project_knowledge_facts
      WHERE project_id = ${projectId}
        AND ${status === null ? sql`status IN ('confirmed', 'proposed')` : sql`status = ${status}`}
        AND (${includeSuperseded ? 1 : 0} = 1 OR superseded_by_id IS NULL)
        AND sources_json LIKE '%"message"%'
      ORDER BY id ASC LIMIT ${limit}`;
    const facts = [];
    for (const row of rows) facts.push({ id: row.id, sources: yield* decodeSources(row.sources) });
    return facts;
  });
  const recordRetrieval = Effect.fn("ProjectKnowledgeStore.recordRetrieval")(function* (
    projectId: ProjectId,
    ids: ReadonlyArray<ProjectFactId>,
  ) {
    if (ids.length === 0) return;
    yield* sql`UPDATE project_knowledge_facts SET retrieval_count = retrieval_count + 1
      WHERE project_id = ${projectId} AND status IN ('confirmed', 'proposed') AND ${sql.in("id", ids)}`;
  });
  // A sent record is final: a later re-preparation of the same attempt cannot rewrite what
  // the provider already received.
  const recordDelivery = Effect.fn("ProjectKnowledgeStore.recordDelivery")(function* (
    delivery: typeof ProjectKnowledgeDelivery.Type,
  ) {
    yield* sql`INSERT INTO project_knowledge_deliveries (
      attempt_id, run_id, thread_id, message_id, project_id, provider_instance_id, status,
      items_json, omissions_json, created_at, updated_at
    ) VALUES (
      ${delivery.attemptId}, ${delivery.runId}, ${delivery.threadId}, ${delivery.messageId},
      ${delivery.projectId}, ${delivery.providerInstanceId}, ${delivery.status},
      ${encodeDeliveryItems(delivery.items)}, ${encodeDeliveryOmissions(delivery.omissions)},
      ${delivery.createdAt}, ${delivery.updatedAt}
    ) ON CONFLICT (attempt_id) DO UPDATE SET
      status = excluded.status, items_json = excluded.items_json,
      omissions_json = excluded.omissions_json, updated_at = excluded.updated_at
    WHERE project_knowledge_deliveries.status != 'sent'`;
  });
  // Forget must not leave a recoverable copy: as-sent excerpts of the fact go with it, while the
  // record skeleton (ids, revisions, digests, status) stays to explain what was sent.
  const scrubDeliveries = Effect.fn("ProjectKnowledgeStore.scrubDeliveries")(function* (
    projectId: ProjectId,
    factId: ProjectFactId,
  ) {
    const rows = yield* sql<{ readonly attemptId: string; readonly items: string }>`
      SELECT attempt_id AS "attemptId", items_json AS items FROM project_knowledge_deliveries
      WHERE project_id = ${projectId} AND instr(items_json, ${factId}) > 0`;
    for (const row of rows) {
      const items = yield* decodeDeliveryItems(row.items);
      let changed = false;
      const scrubbed = items.map((item) => {
        if (
          item.contentRemoved ||
          !item.context.selections.some(
            (selection) => selection.kind === "fact" && selection.factId === factId,
          )
        )
          return item;
        changed = true;
        return { ...item, text: "", contentRemoved: true };
      });
      if (changed)
        yield* sql`UPDATE project_knowledge_deliveries SET items_json = ${encodeDeliveryItems(scrubbed)}
          WHERE attempt_id = ${row.attemptId}`;
    }
  });
  const deliveries = Effect.fn("ProjectKnowledgeStore.deliveries")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    const rows = yield* sql`
      SELECT attempt_id AS "attemptId", run_id AS "runId", thread_id AS "threadId",
        message_id AS "messageId", project_id AS "projectId",
        provider_instance_id AS "providerInstanceId", status, items_json AS items,
        omissions_json AS omissions, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM project_knowledge_deliveries
      WHERE project_id = ${projectId} AND thread_id = ${threadId} AND message_id = ${messageId}
      ORDER BY created_at ASC, attempt_id ASC LIMIT 20`;
    return yield* decodeDeliveries(rows);
  });
  const sentDeliveries = Effect.fn("ProjectKnowledgeStore.sentDeliveries")(function* (
    projectId: ProjectId,
    threadIds: ReadonlyArray<ThreadId>,
    runIds: ReadonlyArray<RunId>,
  ) {
    if (threadIds.length === 0 || runIds.length === 0) return [];
    const rows = yield* sql`
      SELECT attempt_id AS "attemptId", run_id AS "runId", thread_id AS "threadId",
        message_id AS "messageId", project_id AS "projectId",
        provider_instance_id AS "providerInstanceId", status, items_json AS items,
        omissions_json AS omissions, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM project_knowledge_deliveries
      WHERE project_id = ${projectId} AND ${sql.in("thread_id", threadIds)}
        AND ${sql.in("run_id", runIds)} AND status = 'sent'
      ORDER BY created_at ASC, attempt_id ASC`;
    return yield* decodeDeliveries(rows);
  });
  return {
    find,
    findMany,
    list,
    insert,
    update,
    receipt,
    record,
    candidates,
    similar,
    recordHistory,
    eraseHistory,
    history,
    statusCounts,
    citedFacts,
    recordRetrieval,
    recordDelivery,
    scrubDeliveries,
    deliveries,
    sentDeliveries,
  };
});
