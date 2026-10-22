import {
  IsoDateTime,
  MessageId,
  ThreadSearchCursor,
  OrchestrationThreadSearchSource,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  {
    operation: Schema.Literals(["query", "decode", "cursor"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread search ${this.operation} failed.`;
  }
}

const SearchRequest = Schema.Struct({
  pattern: Schema.String,
  limit: Schema.Int,
  projectId: Schema.NullOr(ProjectId),
  includeArchived: Schema.Boolean,
  cursor: Schema.NullOr(ThreadSearchCursor),
});
const SearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  messageId: MessageId,
  updatedAt: IsoDateTime,
  archived: Schema.Number,
  rank: Schema.Literals([0, 1]),
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) {
    return normalizedText;
  }
  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

export class ThreadSearch extends Context.Service<
  ThreadSearch,
  {
    readonly search: (
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchError>;
  }
>()("t3/orchestration-v2/ThreadSearch") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const searchRows = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    execute: ({ pattern, limit, projectId, includeArchived, cursor }) => sql`
      WITH candidate AS (
        SELECT
          threads.thread_id,
          threads.project_id,
          threads.archived_at,
          messages.role,
          json_extract(messages.payload_json, '$.text') AS match_text,
          messages.created_at AS message_created_at,
          messages.message_id,
          threads.updated_at AS thread_updated_at
        FROM orchestration_v2_projection_messages AS messages
        INNER JOIN orchestration_v2_projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND (${includeArchived ? 1 : 0} = 1 OR threads.archived_at IS NULL)
          AND (${projectId} IS NULL OR threads.project_id = ${projectId})
          AND projects.deleted_at IS NULL
          AND messages.streaming = 0
          AND messages.role IN ('user', 'assistant')
          AND json_extract(messages.payload_json, '$.text') LIKE ${pattern} ESCAPE '!'
      ),
      ranked AS (
        SELECT
          thread_id,
          project_id,
          role AS source,
          message_id,
          archived_at,
          match_text,
          message_created_at,
          CASE role WHEN 'user' THEN 0 ELSE 1 END AS match_rank,
          thread_updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY
              CASE role WHEN 'user' THEN 0 ELSE 1 END ASC,
              message_created_at DESC,
              message_id ASC
          ) AS thread_match_rank
        FROM candidate
      )
      SELECT
        thread_id AS "threadId",
        project_id AS "projectId",
        source,
        message_id AS "messageId",
        thread_updated_at AS "updatedAt",
        archived_at IS NOT NULL AS archived,
        match_rank AS rank,
        match_text AS "matchText",
        message_created_at AS "messageCreatedAt"
      FROM ranked
      WHERE thread_match_rank = 1
        AND (${cursor === null ? 1 : 0} = 1
          OR match_rank > ${cursor?.rank ?? 0}
          OR (match_rank = ${cursor?.rank ?? 0} AND thread_updated_at < ${cursor?.updatedAt ?? ""})
          OR (match_rank = ${cursor?.rank ?? 0} AND thread_updated_at = ${cursor?.updatedAt ?? ""}
            AND thread_id > ${cursor?.threadId ?? ""}))
      ORDER BY match_rank ASC, thread_updated_at DESC, thread_id ASC
      LIMIT ${limit}
    `,
  });

  const search: ThreadSearch["Service"]["search"] = Effect.fn("ThreadSearch.search")(
    function* (input) {
      const limit = input.limit ?? 50;
      if (
        input.cursor !== undefined &&
        (input.cursor.query !== input.query ||
          input.cursor.projectId !== (input.projectId ?? null) ||
          input.cursor.includeArchived !== (input.includeArchived ?? false))
      ) {
        return yield* new ThreadSearchError({ operation: "cursor", cause: "Search scope changed" });
      }
      // The scan reads every message, so run it on the reader worker rather
      // than the event loop.
      const rows = yield* sql
        .withTransaction(
          searchRows({
            pattern: `%${escapeLikePattern(input.query)}%`,
            limit: limit + 1,
            projectId: input.projectId ?? null,
            includeArchived: input.includeArchived ?? false,
            cursor: input.cursor ?? null,
          }),
        )
        .pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError(
            (cause) =>
              new ThreadSearchError({
                operation: Schema.isSchemaError(cause) ? "decode" : "query",
                cause,
              }),
          ),
        );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        nextCursor:
          rows.length > limit && last
            ? {
                query: input.query,
                projectId: input.projectId ?? null,
                includeArchived: input.includeArchived ?? false,
                rank: last.rank,
                updatedAt: last.updatedAt,
                threadId: last.threadId,
              }
            : null,
        matches: yield* Effect.forEach(page, (row) =>
          crypto.digest("SHA-256", new TextEncoder().encode(row.matchText)).pipe(
            Effect.map((hash) => ({
              threadId: row.threadId,
              projectId: row.projectId,
              source: row.source,
              messageId: row.messageId,
              digest: Hex.encode(hash),
              archived: row.archived === 1,
              snippet: buildSearchSnippet(row.matchText, input.query),
              messageCreatedAt: row.messageCreatedAt,
            })),
            Effect.mapError((cause) => new ThreadSearchError({ operation: "query", cause })),
          ),
        ),
      };
    },
  );

  return ThreadSearch.of({ search });
});

export const layer = Layer.effect(ThreadSearch, make);
