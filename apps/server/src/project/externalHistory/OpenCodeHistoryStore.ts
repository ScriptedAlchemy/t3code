import * as NodeSqlite from "node:sqlite";
import { ExternalHistoryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type { TranscriptItem } from "../agentTranscripts.ts";
import {
  fileVersion,
  type LocalHistoryStore,
  type LocalThreadRef,
  type ThreadCache,
} from "./LocalHistoryStore.ts";

const decodeSessions = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.NullOr(Schema.String),
      directory: Schema.String,
      time_updated: Schema.Number,
    }),
  ),
);
const decodeMessages = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      type: Schema.Literals(["user", "assistant"]),
      visible: Schema.String,
    }),
  ),
);
const decodeVisible = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      text: Schema.optionalKey(Schema.String),
      content: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            type: Schema.Literals(["text", "tool"]),
            text: Schema.NullOr(Schema.String),
            id: Schema.NullOr(Schema.String),
            name: Schema.NullOr(Schema.String),
            output: Schema.Array(Schema.String),
          }),
        ),
      ),
    }),
  ),
);
const isHistoryError = Schema.is(ExternalHistoryError);
const mapError = (cause: unknown) =>
  isHistoryError(cause) ? cause : new ExternalHistoryError({ reason: "unavailable", cause });

export const makeOpenCodeHistoryStore = Effect.fn("ExternalHistory.openOpenCodeStore")(function* (
  filePath: string,
  cache: ThreadCache,
) {
  const fs = yield* FileSystem.FileSystem;
  if ((yield* fs.stat(filePath)).type !== "File")
    return yield* new ExternalHistoryError({ reason: "unsupported" });
  const withDatabase = <A>(read: (db: NodeSqlite.DatabaseSync) => A) =>
    Effect.try({
      try: () => {
        const db = new NodeSqlite.DatabaseSync(filePath, { readOnly: true });
        try {
          db.exec("PRAGMA busy_timeout = 100");
          return read(db);
        } finally {
          db.close();
        }
      },
      catch: mapError,
    });
  yield* withDatabase((db) => {
    for (const [table, required] of [
      ["session_v2", ["id", "directory", "title", "parent_id", "time_updated"]],
      ["session_message", ["id", "session_id", "type", "seq", "data"]],
    ] as const) {
      const columns = new Set(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => row["name"]),
      );
      if (required.some((column) => !columns.has(column)))
        throw new ExternalHistoryError({ reason: "unsupported" });
    }
  });
  const version = Effect.gen(function* () {
    const database = fileVersion(yield* fs.stat(filePath));
    const wal = yield* fs.stat(`${filePath}-wal`).pipe(
      Effect.map(fileVersion),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
      }),
    );
    return database + wal;
  }).pipe(Effect.mapError(mapError));
  let listing: { version: string; refs: ReadonlyArray<LocalThreadRef> } | undefined;
  const listThreads = Effect.gen(function* () {
    const current = yield* version;
    if (listing?.version === current) return listing.refs;
    const rows = yield* withDatabase((db) =>
      decodeSessions(
        db
          .prepare(
            "SELECT id, title, directory, time_updated FROM session_v2 WHERE parent_id IS NULL ORDER BY time_updated DESC, id DESC LIMIT 50001",
          )
          .all(),
      ),
    );
    if (rows.length > 50_000) return yield* new ExternalHistoryError({ reason: "limit_exceeded" });
    const refs = rows.map((row) => ({
      key: row.id,
      title: row.title ?? "Conversation",
      cwd: row.directory,
      updatedAt: row.time_updated,
      version: current,
    }));
    listing = { version: current, refs };
    return refs;
  });
  const loadThread = Effect.fn("ExternalHistory.loadOpenCodeThread")(function* (
    ref: LocalThreadRef,
  ) {
    const current = yield* version;
    const thread = yield* cache(
      `${filePath}\0${ref.key}\0${current}`,
      withDatabase((db) => {
        db.exec("BEGIN");
        const session = decodeSessions(
          db
            .prepare(
              "SELECT id, title, directory, time_updated FROM session_v2 WHERE id = ? AND parent_id IS NULL",
            )
            .all(ref.key),
        )[0];
        if (!session) throw new ExternalHistoryError({ reason: "missing" });
        const rows = decodeMessages(
          db
            .prepare(`SELECT id, type, CASE WHEN json_valid(data) THEN
        CASE WHEN type = 'user' THEN json_object('text', data ->> '$.text')
        WHEN json_type(data, '$.content') = 'array' THEN json_object('content', json((
          SELECT coalesce(json_group_array(json_object(
            'type', c.value ->> '$.type', 'text', c.value ->> '$.text',
            'id', c.value ->> '$.id', 'name', c.value ->> '$.name',
            'output', json((SELECT coalesce(json_group_array(p.value ->> '$.text'), '[]')
              FROM json_each(c.value, '$.state.content') p WHERE p.value ->> '$.type' = 'text'))
          )), '[]') FROM json_each(data, '$.content') c WHERE c.value ->> '$.type' IN ('text', 'tool')
        ))) END END AS visible
        FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant') ORDER BY seq, id LIMIT 100001`)
            .all(ref.key),
        );
        if (rows.length > 100_000) throw new ExternalHistoryError({ reason: "limit_exceeded" });
        const items: TranscriptItem[] = [];
        let chars = 0;
        for (const row of rows) {
          if (row.visible.length > 16 * 1024 * 1024)
            throw new ExternalHistoryError({ reason: "limit_exceeded" });
          const visible = decodeVisible(row.visible);
          const text =
            row.type === "user"
              ? visible.text
              : visible.content
                  ?.filter((part) => part.type === "text")
                  .map((part) => part.text ?? "")
                  .join("\n");
          if (text) items.push({ id: row.id, role: row.type, text });
          for (const part of visible.content ?? []) {
            if (part.type !== "tool" || !part.id) continue;
            const text = [part.name, ...part.output].filter(Boolean).join("\n");
            if (text) items.push({ id: `${row.id}/tool/${part.id}`, role: "tool", text });
          }
          chars +=
            (text?.length ?? 0) +
            (visible.content?.reduce((sum, part) => sum + part.output.join("\n").length, 0) ?? 0);
          if (chars > 16 * 1024 * 1024)
            throw new ExternalHistoryError({ reason: "limit_exceeded" });
        }
        return {
          version: current,
          title: session.title ?? "Conversation",
          cwd: session.directory,
          items,
        };
      }),
    );
    if ((yield* version) !== current) return yield* new ExternalHistoryError({ reason: "changed" });
    return thread;
  });
  return { listThreads, loadThread } satisfies LocalHistoryStore;
}, Effect.mapError(mapError));
