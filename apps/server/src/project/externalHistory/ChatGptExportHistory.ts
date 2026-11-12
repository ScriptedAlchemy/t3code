import { ExternalHistoryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { createTranscriptJsonReader, TranscriptJsonLimitError } from "../AgentSessionJson.ts";
import {
  fileVersion,
  type LocalHistoryStore,
  type LocalThreadRef,
  type ThreadCache,
} from "./LocalHistoryStore.ts";

const MAX_CONVERSATION_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const Message = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  author: Schema.Struct({ role: Schema.String }),
  content: Schema.Struct({
    parts: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    text: Schema.optionalKey(Schema.String),
  }),
  metadata: Schema.optionalKey(
    Schema.Struct({
      is_visually_hidden_from_conversation: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const Conversation = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  conversation_id: Schema.optionalKey(Schema.String),
  title: Schema.String,
  current_node: Schema.NullOr(Schema.String),
  mapping: Schema.Record(
    Schema.String,
    Schema.Struct({
      parent: Schema.NullOr(Schema.String),
      message: Schema.NullOr(Message),
    }),
  ),
});
const decodeConversation = Schema.decodeUnknownEffect(Conversation);
const isHistoryError = Schema.is(ExternalHistoryError);
const isTranscriptJsonLimitError = Schema.is(TranscriptJsonLimitError);
const decodeMetadata = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    conversation_id: Schema.optionalKey(Schema.String),
    title: Schema.String,
  }),
);

interface VisibleMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
}

function visibleBranch(conversation: typeof Conversation.Type): ReadonlyArray<VisibleMessage> {
  const seen = new Set<string>();
  const messageIds = new Set<string>();
  const messages: Array<VisibleMessage> = [];
  let nodeId = conversation.current_node;
  if (nodeId === null && Object.keys(conversation.mapping).length > 0)
    throw new ExternalHistoryError({ reason: "unsupported" });
  while (nodeId !== null) {
    if (seen.has(nodeId)) throw new ExternalHistoryError({ reason: "unsupported" });
    seen.add(nodeId);
    const node = Object.hasOwn(conversation.mapping, nodeId)
      ? conversation.mapping[nodeId]
      : undefined;
    if (!node) throw new ExternalHistoryError({ reason: "unsupported" });
    const message = node.message;
    if (message && !message.metadata?.is_visually_hidden_from_conversation) {
      const role = message.author.role;
      if (role === "user" || role === "assistant" || role === "tool") {
        const text =
          message.content.text ??
          message.content.parts
            ?.filter((part): part is string => typeof part === "string")
            .join("\n") ??
          "";
        if (text.length > 0) {
          if (messageIds.has(message.id)) throw new ExternalHistoryError({ reason: "unsupported" });
          messageIds.add(message.id);
          messages.push({ id: message.id, role, text });
        }
      }
    }
    nodeId = node.parent;
  }
  return messages.reverse();
}

// Select text and branch links before assembly. Media objects and unrelated conversations
// never become a second in-memory copy of the export.
function selectExportPath(path: ReadonlyArray<string | number | null>, index: number): boolean {
  if (path.length === 0) return true;
  if (path[0] !== index) return false;
  if (path.length === 1) return true;
  const field = path[1];
  if (field !== "mapping")
    return (
      path.length === 2 &&
      (field === "id" ||
        field === "conversation_id" ||
        field === "title" ||
        field === "current_node")
    );
  if (path.length <= 3) return true;
  if (path[3] === "parent") return path.length === 4;
  if (path[3] !== "message") return false;
  if (path.length === 4) return true;
  if (path[4] === "id") return path.length === 5;
  if (path[4] === "author") return path.length === 5 || (path.length === 6 && path[5] === "role");
  if (path[4] === "metadata")
    return (
      path.length === 5 || (path.length === 6 && path[5] === "is_visually_hidden_from_conversation")
    );
  if (path[4] !== "content") return false;
  return (
    path.length === 5 ||
    (path[5] === "text" && path.length === 6) ||
    (path[5] === "parts" && path.length <= 7)
  );
}

export const makeChatGptExportStore = Effect.fn("ChatGptExportHistory.open")(function* (
  filePath: string,
  cache: ThreadCache,
) {
  const fs = yield* FileSystem.FileSystem;
  const mapError = (cause: unknown) =>
    isHistoryError(cause)
      ? cause
      : new ExternalHistoryError({
          reason: isTranscriptJsonLimitError(cause)
            ? "limit_exceeded"
            : PlatformError.isPlatformError(cause) && cause.reason._tag === "NotFound"
              ? "missing"
              : "unavailable",
          cause,
        });

  const readConversation = Effect.fn("ChatGptExportHistory.readConversation")(function* (
    filePath: string,
    index: number,
    expected?: string,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(filePath, { flag: "r" });
        const stat = yield* file.stat;
        if (stat.type !== "File") return yield* new ExternalHistoryError({ reason: "unsupported" });
        const identity = fileVersion(stat);
        const version = identity;
        if (expected !== undefined && expected !== version)
          return yield* new ExternalHistoryError({ reason: "changed" });
        let value: unknown;
        let found = false;
        let allocated = 0;
        const reader = createTranscriptJsonReader(
          (bytes) => {
            allocated += bytes;
            if (allocated > MAX_CONVERSATION_BYTES)
              throw new TranscriptJsonLimitError({ message: "Export conversation limit" });
          },
          (path) => selectExportPath(path, index),
          {
            onArrayItem: (current, record) => {
              allocated = 0;
              if (current !== index) return true;
              value = record;
              found = true;
              return false;
            },
          },
        );
        const decoder = new TextDecoder("utf-8", { fatal: true });
        while (!reader.stopped) {
          const bytes = yield* file.readAlloc(CHUNK_BYTES);
          if (Option.isNone(bytes)) break;
          yield* Effect.try({
            try: () => reader.write(decoder.decode(bytes.value, { stream: true })),
            catch: mapError,
          });
        }
        if (!reader.stopped) {
          const finished = yield* Effect.try({
            try: () => {
              reader.write(decoder.decode());
              return reader.finish();
            },
            catch: mapError,
          });
          if (!Array.isArray(finished))
            return yield* new ExternalHistoryError({ reason: "unsupported" });
        }
        if (
          identity !== fileVersion(yield* file.stat) ||
          identity !== fileVersion(yield* fs.stat(filePath))
        )
          return yield* new ExternalHistoryError({ reason: "changed" });
        if (!found) return { file: version, conversation: null };
        const conversation = yield* decodeConversation(value).pipe(
          Effect.mapError(() => new ExternalHistoryError({ reason: "unsupported" })),
        );
        const threadId = conversation.id ?? conversation.conversation_id;
        if (!threadId || threadId.length > 512)
          return yield* new ExternalHistoryError({ reason: "unsupported" });
        const messages = yield* Effect.try({
          try: () => visibleBranch(conversation),
          catch: mapError,
        });
        return {
          file: version,
          conversation: { threadId, title: conversation.title.slice(0, 512), messages },
        };
      }),
    ).pipe(Effect.mapError(mapError));
  });

  let listing: { version: string; refs: ReadonlyArray<LocalThreadRef> } | undefined;
  const listThreads = Effect.gen(function* () {
    const stat = yield* fs.stat(filePath);
    if (stat.type !== "File") return yield* new ExternalHistoryError({ reason: "unsupported" });
    const version = fileVersion(stat);
    if (listing?.version === version) return listing.refs;
    const refs: LocalThreadRef[] = [];
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(filePath, { flag: "r" });
        if (fileVersion(yield* file.stat) !== version)
          return yield* new ExternalHistoryError({ reason: "changed" });
        let allocated = 0;
        const reader = createTranscriptJsonReader(
          (bytes) => {
            allocated += bytes;
            if (allocated > MAX_CONVERSATION_BYTES)
              throw new TranscriptJsonLimitError({ message: "Export metadata limit" });
          },
          (path) =>
            path.length <= 1 ||
            (path.length === 2 &&
              (path[1] === "id" || path[1] === "conversation_id" || path[1] === "title")),
          {
            onArrayItem: (index, value) => {
              allocated = 0;
              const metadata = decodeMetadata(value);
              const id = metadata.id ?? metadata.conversation_id;
              if (!id) throw new ExternalHistoryError({ reason: "unsupported" });
              const key = `${index}:${id}`;
              if (key.length > 512 || refs.length >= 50_000)
                throw new ExternalHistoryError({ reason: "limit_exceeded" });
              refs.push({
                key,
                title: metadata.title,
                updatedAt: Option.map(stat.mtime, (d) => d.getTime()).pipe(
                  Option.getOrElse(() => 0),
                ),
                version,
              });
              return true;
            },
          },
        );
        const decoder = new TextDecoder("utf-8", { fatal: true });
        while (true) {
          const bytes = yield* file.readAlloc(CHUNK_BYTES);
          if (Option.isNone(bytes)) break;
          yield* Effect.try({
            try: () => reader.write(decoder.decode(bytes.value, { stream: true })),
            catch: mapError,
          });
        }
        const result = yield* Effect.try({
          try: () => {
            reader.write(decoder.decode());
            return reader.finish();
          },
          catch: mapError,
        });
        if (!Array.isArray(result))
          return yield* new ExternalHistoryError({ reason: "unsupported" });
        if (
          fileVersion(yield* file.stat) !== version ||
          fileVersion(yield* fs.stat(filePath)) !== version
        )
          return yield* new ExternalHistoryError({ reason: "changed" });
      }),
    );
    listing = { version, refs };
    return refs;
  }).pipe(Effect.mapError(mapError));
  const loadThread = Effect.fn("ChatGptExportHistory.loadThread")(function* (ref: LocalThreadRef) {
    const version = fileVersion(yield* fs.stat(filePath));
    const match = /^(0|[1-9][0-9]*):(.+)$/.exec(ref.key);
    if (!match || !Number.isSafeInteger(Number(match[1])))
      return yield* new ExternalHistoryError({ reason: "invalid_cursor" });
    return yield* cache(
      `${filePath}\0${ref.key}\0${version}`,
      Effect.gen(function* () {
        const result = yield* readConversation(filePath, Number(match[1]), version);
        if (!result.conversation || result.conversation.threadId !== match[2])
          return yield* new ExternalHistoryError({ reason: "changed" });
        return {
          version,
          title: result.conversation.title,
          cwd: null,
          items: result.conversation.messages,
        };
      }),
    );
  }, Effect.mapError(mapError));
  return { listThreads, loadThread } satisfies LocalHistoryStore;
});
