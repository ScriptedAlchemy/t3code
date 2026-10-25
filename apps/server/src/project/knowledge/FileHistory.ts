import type {
  ProjectFileHistoryInput,
  ProjectFileHistoryResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";

// Bounds checkpoint metadata work even when every checkpoint has an empty file list.
const CATCH_UP_BATCH = 500;
const CATCH_UP_BATCHES_PER_READ = 20;
// Shared across every checkpoint in a transaction: several large checkpoints must not multiply
// the amount of work holding the database's write lock.
const FILES_PER_BATCH = 2_000;

const encodeCheckpointIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodePages = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        start: Schema.Number,
        end: Schema.Number,
        next: Schema.NullOr(Schema.Number),
      }),
    ),
  ),
);

export class FileHistoryProjectNotFound extends Schema.TaggedError<FileHistoryProjectNotFound>()(
  "FileHistoryProjectNotFound",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project ${this.projectId} is unavailable for file history.`;
  }
}

export class FileHistoryUnavailable extends Schema.TaggedError<FileHistoryUnavailable>()(
  "FileHistoryUnavailable",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "File history could not be read.";
  }
}

/**
 * Which threads' checkpoints listed a file. The index is derived from checkpoint projections
 * on read, never from the event sink, so it costs the turn lane nothing; deleting both index
 * tables rebuilds it on the next read.
 */
export class FileHistory extends Context.Service<
  FileHistory,
  {
    readonly read: (
      input: ProjectFileHistoryInput,
    ) => Effect.Effect<
      ProjectFileHistoryResult,
      FileHistoryProjectNotFound | FileHistoryUnavailable | ProjectStore.ProjectStoreV2Error
    >;
  }
>()("t3/project/knowledge/FileHistory") {}

function normalizePath(path: string): string {
  return path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "");
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const catchUpLock = yield* Semaphore.make(1);

  const pendingCheckpoints = (projectId: ProjectId, limit: number) =>
    sql<{ readonly id: string }>`
      SELECT c.checkpoint_id AS id
      FROM orchestration_v2_projection_checkpoints c
      JOIN orchestration_v2_projection_threads t ON t.thread_id = c.thread_id
      LEFT JOIN project_code_checkpoint_marks m ON m.checkpoint_id = c.checkpoint_id
      WHERE t.project_id = ${projectId}
        AND (m.checkpoint_id IS NULL OR m.captured_at != c.captured_at OR m.status != c.status
          OR m.next_file_index IS NOT NULL)
      LIMIT ${limit}`;

  const indexBatch = (ids: ReadonlyArray<string>) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const idsJson = encodeCheckpointIds(ids);
        // A checkpoint recaptured since its last page starts over from its first file.
        const starts = yield* sql<{
          readonly id: string;
          readonly start: number;
          readonly total: number;
        }>`
          SELECT c.checkpoint_id AS id,
            CASE WHEN m.captured_at = c.captured_at AND m.status = c.status
              THEN coalesce(m.next_file_index, 0) ELSE 0 END AS start,
            CASE WHEN json_type(c.payload_json, '$.files') = 'array'
              THEN json_array_length(c.payload_json, '$.files') ELSE 0 END AS total
          FROM orchestration_v2_projection_checkpoints c
          LEFT JOIN project_code_checkpoint_marks m ON m.checkpoint_id = c.checkpoint_id
          WHERE c.checkpoint_id IN (SELECT value FROM json_each(${idsJson}))`;
        const pages = [];
        let remaining = FILES_PER_BATCH;
        for (const { id, start, total } of starts) {
          if (remaining === 0) break;
          const end = start + Math.min(remaining, Math.max(0, total - start));
          pages.push({ id, start, end, next: end < total ? end : null });
          remaining -= end - start;
        }
        const pagesJson = encodePages(pages);
        yield* sql`DELETE FROM project_code_checkpoint_files
          WHERE checkpoint_id IN (
            SELECT json_extract(value, '$.id') FROM json_each(${pagesJson})
            WHERE json_extract(value, '$.start') = 0)`;
        yield* sql`INSERT OR REPLACE INTO project_code_checkpoint_files
            (path, checkpoint_id, thread_id, kind, additions, deletions)
          SELECT json_extract(f.value, '$.path'), c.checkpoint_id, c.thread_id,
            coalesce(json_extract(f.value, '$.kind'), 'modified'),
            coalesce(json_extract(f.value, '$.additions'), 0),
            coalesce(json_extract(f.value, '$.deletions'), 0)
          FROM json_each(${pagesJson}) p
          JOIN orchestration_v2_projection_checkpoints c
            ON c.checkpoint_id = json_extract(p.value, '$.id'),
            json_each(c.payload_json, '$.files') f
          WHERE json_type(c.payload_json, '$.files') = 'array'
            AND f.type = 'object'
            AND f.key >= json_extract(p.value, '$.start')
            AND f.key < json_extract(p.value, '$.end')
            AND json_type(f.value, '$.path') = 'text'`;
        yield* sql`INSERT OR REPLACE INTO project_code_checkpoint_marks
            (checkpoint_id, captured_at, status, next_file_index)
          SELECT c.checkpoint_id, c.captured_at, c.status, json_extract(p.value, '$.next')
          FROM json_each(${pagesJson}) p
          JOIN orchestration_v2_projection_checkpoints c
            ON c.checkpoint_id = json_extract(p.value, '$.id')`;
      }),
    );

  const catchUp = Effect.fn("FileHistory.catchUp")(function* (projectId: ProjectId) {
    for (let batch = 0; batch < CATCH_UP_BATCHES_PER_READ; batch += 1) {
      const pending = yield* pendingCheckpoints(projectId, CATCH_UP_BATCH);
      if (pending.length === 0) return 0;
      yield* indexBatch(pending.map((row) => row.id));
    }
    return (yield* pendingCheckpoints(projectId, 10_000)).length;
  });

  const read: FileHistory["Service"]["read"] = Effect.fn("FileHistory.read")(
    function* (input) {
      const project = yield* projects.get(input.projectId);
      if (Option.isNone(project) || project.value.deletedAt !== null) {
        return yield* new FileHistoryProjectNotFound({ projectId: input.projectId });
      }
      const path = normalizePath(input.path);
      const limit = input.limit ?? 20;
      const pending = yield* catchUpLock.withPermit(catchUp(input.projectId));
      // SQLite returns the bare `kind` from the row that supplied MAX(captured_at).
      const rows = yield* sql<{
        readonly threadId: ThreadId;
        readonly title: string;
        readonly archivedAt: string | null;
        readonly checkpoints: number;
        readonly lastCheckpointAt: string;
        readonly lastKind: string;
        readonly additions: number;
        readonly deletions: number;
      }>`
      SELECT f.thread_id AS "threadId", t.title AS title, t.archived_at AS "archivedAt",
        COUNT(*) AS checkpoints, MAX(c.captured_at) AS "lastCheckpointAt", f.kind AS "lastKind",
        SUM(f.additions) AS additions, SUM(f.deletions) AS deletions
      FROM project_code_checkpoint_files f
      JOIN orchestration_v2_projection_checkpoints c ON c.checkpoint_id = f.checkpoint_id
      JOIN orchestration_v2_projection_threads t ON t.thread_id = f.thread_id
      WHERE f.path = ${path} AND t.project_id = ${input.projectId} AND t.deleted_at IS NULL
      GROUP BY f.thread_id
      ORDER BY "lastCheckpointAt" DESC, f.thread_id ASC
      LIMIT ${limit + 1}`;
      return {
        path: path.slice(0, 2048),
        relation: "present-at-checkpoint" as const,
        entries: rows.slice(0, limit).map((row) => ({
          threadId: row.threadId,
          title: row.title.slice(0, 512),
          archived: row.archivedAt !== null,
          checkpoints: Math.max(1, row.checkpoints),
          lastCheckpointAt: row.lastCheckpointAt,
          lastKind: row.lastKind.slice(0, 512),
          additions: Math.max(0, row.additions),
          deletions: Math.max(0, row.deletions),
        })),
        limitReached: rows.length > limit,
        index: {
          state: pending === 0 ? ("complete" as const) : ("catching-up" as const),
          pendingCheckpoints: pending,
        },
      };
    },
    Effect.catchTags({ SqlError: (cause) => Effect.fail(new FileHistoryUnavailable({ cause })) }),
  );

  return FileHistory.of({ read });
});

export const layer = Layer.effect(FileHistory, make);
