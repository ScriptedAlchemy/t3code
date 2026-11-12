import { ExternalHistoryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import {
  TranscriptRecord,
  conversationItem,
  activePiBranch,
  emptyClaudeFields,
  foldClaudeFields,
  transcriptItems,
  type DecodedTranscriptRecord,
  type TranscriptItem,
} from "../agentTranscripts.ts";
import {
  createTranscriptJsonReader,
  createTranscriptJsonSelector,
  TranscriptJsonLimitError,
} from "../AgentSessionJson.ts";
import {
  fileVersion,
  type LocalThreadRef,
  type LocalHistoryStore,
  type ThreadCache,
} from "./LocalHistoryStore.ts";

const decodeRecord = Schema.decodeUnknownOption(TranscriptRecord);
const selectRecord = createTranscriptJsonSelector(TranscriptRecord);
const isHistoryError = Schema.is(ExternalHistoryError);
const isLimitError = Schema.is(TranscriptJsonLimitError);
const mapError = (cause: unknown) =>
  isHistoryError(cause)
    ? cause
    : new ExternalHistoryError({
        reason: isLimitError(cause)
          ? "limit_exceeded"
          : PlatformError.isPlatformError(cause)
            ? cause.reason._tag === "NotFound"
              ? "missing"
              : "unavailable"
            : "unsupported",
        cause,
      });

function projectThread(
  records: ReadonlyArray<DecodedTranscriptRecord>,
  source: "claudeAgent" | "pi",
  version: string,
) {
  const origin = source === "claudeAgent" && records.some((r) => r.entrypoint === "t3-code");
  const fields = records.reduce(foldClaudeFields, emptyClaudeFields);
  const items = new Map<string, TranscriptItem>();
  for (const record of source === "pi" ? activePiBranch(records) : records) {
    const visible = transcriptItems(record, source);
    const conversation = conversationItem(record, source);
    if (!origin && conversation && !conversation.id)
      throw new ExternalHistoryError({ reason: "unsupported" });
    for (const item of visible) {
      const previous = items.get(item.id);
      if (previous && (previous.role !== item.role || previous.text !== item.text))
        throw new ExternalHistoryError({ reason: "unsupported" });
      items.set(item.id, item);
    }
  }
  const firstUser = [...items.values()].find((item) => item.role === "user");
  const title =
    source === "pi"
      ? records.findLast((r) => r.type === "session_info")?.name?.trim()
      : (fields.customTitle ?? fields.title);
  return {
    version,
    title: title || firstUser?.text.split("\n")[0]?.slice(0, 100) || "Conversation",
    cwd: records.find((r) => r.cwd?.trim())?.cwd ?? null,
    items: origin ? [] : [...items.values()],
    ...(origin ? { origin: "t3" as const } : {}),
  };
}

const makeJsonlHistoryStore = Effect.fn("ExternalHistory.openJsonlStore")(function* (
  root: string,
  source: "claudeAgent" | "pi",
  cache: ThreadCache,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.realPath(
    source === "claudeAgent" ? path.join(root, "projects") : root,
  );
  if ((yield* fs.stat(directory)).type !== "Directory")
    return yield* new ExternalHistoryError({ reason: "unsupported" });
  let listing:
    | { directories: ReadonlyMap<string, string>; refs: ReadonlyArray<LocalThreadRef> }
    | undefined;
  const listThreads = Effect.gen(function* () {
    if (listing) {
      let unchanged = true;
      for (const [dir, version] of listing.directories) {
        const stat = yield* fs.stat(dir).pipe(Effect.option);
        if (Option.isNone(stat) || fileVersion(stat.value) !== version) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return listing.refs;
    }
    const directories = new Map<string, string>();
    const refs: LocalThreadRef[] = [];
    const rootInfo = yield* fs.stat(directory);
    directories.set(directory, fileVersion(rootInfo));
    const children = yield* fs.readDirectory(directory);
    if (children.length > 50_000)
      return yield* new ExternalHistoryError({ reason: "limit_exceeded" });
    for (const child of children) {
      const childPath = path.join(directory, child);
      if (yield* Effect.isSuccess(fs.readLink(childPath))) continue;
      const info = yield* fs.stat(childPath);
      const files =
        info.type === "Directory"
          ? yield* fs.readDirectory(childPath)
          : source === "pi" && child.endsWith(".jsonl")
            ? [child]
            : [];
      if (info.type === "Directory") directories.set(childPath, fileVersion(info));
      if (directories.size > 50_000 || files.length + refs.length > 50_000)
        return yield* new ExternalHistoryError({ reason: "limit_exceeded" });
      for (const name of files) {
        if (!name.endsWith(".jsonl")) continue;
        const filePath = info.type === "Directory" ? path.join(childPath, name) : childPath;
        if (yield* Effect.isSuccess(fs.readLink(filePath))) continue;
        const stat = yield* fs.stat(filePath);
        if (stat.type !== "File") continue;
        const key = path.relative(directory, filePath).split(path.sep).join("/");
        if (key.length > 512) return yield* new ExternalHistoryError({ reason: "limit_exceeded" });
        refs.push({
          key,
          updatedAt: Option.map(stat.mtime, (d) => d.getTime()).pipe(Option.getOrElse(() => 0)),
          version: fileVersion(stat),
        });
      }
    }
    refs.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
    listing = { directories, refs };
    return refs;
  }).pipe(Effect.mapError(mapError));

  const loadThread = Effect.fn("ExternalHistory.loadJsonlThread")(function* (ref: LocalThreadRef) {
    if (
      ref.key.includes("\\") ||
      ref.key.split("/").some((part) => !part || part === "." || part === "..") ||
      path.isAbsolute(ref.key) ||
      !ref.key.endsWith(".jsonl")
    )
      return yield* new ExternalHistoryError({ reason: "invalid_cursor" });
    const filePath = path.join(directory, ...ref.key.split("/"));
    const canonical = yield* fs.realPath(filePath);
    if (canonical !== filePath) return yield* new ExternalHistoryError({ reason: "changed" });
    const stat = yield* fs.stat(filePath);
    if (stat.type !== "File") return yield* new ExternalHistoryError({ reason: "unsupported" });
    const version = fileVersion(stat);
    const thread = yield* cache(
      `${source}\0${filePath}\0${version}`,
      Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filePath, { flag: "r" });
          if (fileVersion(yield* file.stat) !== version)
            return yield* new ExternalHistoryError({ reason: "changed" });
          const records: DecodedTranscriptRecord[] = [];
          let allocated = 0;
          let reader = createTranscriptJsonReader(
            (bytes) => {
              allocated += bytes;
              if (allocated > 32 * 1024 * 1024)
                throw new TranscriptJsonLimitError({ message: "Transcript text limit" });
            },
            (path) => path[0] !== "payload" && selectRecord(path),
          );
          const finishRecord = () => {
            const decoded = decodeRecord(reader.finish());
            if (Option.isNone(decoded)) throw new ExternalHistoryError({ reason: "unsupported" });
            if (records.length >= 100_000)
              throw new ExternalHistoryError({ reason: "limit_exceeded" });
            records.push(decoded.value);
            reader = createTranscriptJsonReader(
              (bytes) => {
                allocated += bytes;
                if (allocated > 32 * 1024 * 1024)
                  throw new TranscriptJsonLimitError({ message: "Transcript text limit" });
              },
              (path) => path[0] !== "payload" && selectRecord(path),
            );
          };
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let pending = false;
          let readBytes = 0;
          const consume = (text: string) => {
            let start = 0;
            for (let index = 0; index < text.length; index++) {
              if (text[index] !== "\n") continue;
              const part = text.slice(start, index);
              if (pending || part.trim()) {
                reader.write(part);
                finishRecord();
              }
              pending = false;
              start = index + 1;
            }
            const tail = text.slice(start);
            if (tail.trim() || pending) {
              reader.write(tail);
              pending = true;
            }
          };
          while (true) {
            const bytes = yield* file.readAlloc(64 * 1024);
            if (Option.isNone(bytes)) break;
            readBytes += bytes.value.length;
            if (readBytes > 4 * 1024 * 1024 * 1024)
              return yield* new ExternalHistoryError({ reason: "limit_exceeded" });
            yield* Effect.try({
              try: () => consume(decoder.decode(bytes.value, { stream: true })),
              catch: mapError,
            });
          }
          yield* Effect.try({
            try: () => {
              consume(decoder.decode());
              if (pending) finishRecord();
            },
            catch: mapError,
          });
          if (
            fileVersion(yield* file.stat) !== version ||
            fileVersion(yield* fs.stat(filePath)) !== version
          )
            return yield* new ExternalHistoryError({ reason: "changed" });
          return yield* Effect.try({
            try: () => projectThread(records, source, version),
            catch: mapError,
          });
        }),
      ).pipe(Effect.mapError(mapError)),
    );
    if (fileVersion(yield* fs.stat(filePath)) !== version)
      return yield* new ExternalHistoryError({ reason: "changed" });
    return thread;
  }, Effect.mapError(mapError));
  return { listThreads, loadThread } satisfies LocalHistoryStore;
}, Effect.mapError(mapError));

export const makeClaudeHistoryStore = (root: string, cache: ThreadCache) =>
  makeJsonlHistoryStore(root, "claudeAgent", cache);
export const makePiHistoryStore = (root: string, cache: ThreadCache) =>
  makeJsonlHistoryStore(root, "pi", cache);
