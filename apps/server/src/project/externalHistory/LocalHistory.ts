import {
  ExternalHistoryError,
  type ExternalHistoryMatch,
  type ExternalHistoryRequest,
  type ExternalHistoryResponse,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  boundedTextEnd,
  isTextBoundary,
} from "../conversationSummaries/conversationSummarySources.ts";
import {
  makeThreadCache,
  type LocalHistoryStore,
  type LocalThreadRef,
} from "./LocalHistoryStore.ts";

const SearchCursor = Schema.Struct({
  v: Schema.Literal(2),
  sourceId: Schema.String,
  query: Schema.String,
  filterCwd: Schema.NullOr(Schema.String),
  afterKey: Schema.NullOr(Schema.String),
  itemOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  version: Schema.NullOr(Schema.String),
});
const ReadCursor = Schema.Struct({
  v: Schema.Literal(2),
  sourceId: Schema.String,
  key: Schema.String,
  version: Schema.String,
  itemId: Schema.String,
});
const decodeSearchCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(SearchCursor));
const encodeSearchCursor = Schema.encodeSync(Schema.fromJsonString(SearchCursor));
const decodeReadCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(ReadCursor));
const encodeReadCursor = Schema.encodeSync(Schema.fromJsonString(ReadCursor));
const invalidCursor = () => new ExternalHistoryError({ reason: "invalid_cursor" });
const evidence = (item: { readonly role: string; readonly text: string }) =>
  `external-history-v2\n${item.role}\n${item.text}`;

export const makeLocalHistory = Effect.gen(function* () {
  const crypto = yield* Digest.Digest;
  const cache = yield* makeThreadCache;
  const digest = (text: string) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(text)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError((cause) => new ExternalHistoryError({ reason: "unavailable", cause })),
    );
  const search = Effect.fn("ExternalHistory.searchLocal")(function* (
    store: LocalHistoryStore,
    input: Extract<ExternalHistoryRequest, { operation: "search" }>,
  ) {
    const cursor =
      input.cursor === undefined
        ? undefined
        : yield* decodeSearchCursor(input.cursor).pipe(Effect.mapError(invalidCursor));
    if (
      cursor &&
      (cursor.sourceId !== input.sourceId ||
        cursor.query !== input.query ||
        cursor.filterCwd !== (input.filterCwd ?? null))
    )
      return yield* invalidCursor();
    const refs = yield* store.listThreads;
    const index =
      cursor?.afterKey == null ? 0 : refs.findIndex((ref) => ref.key === cursor.afterKey);
    if (index < 0) return yield* new ExternalHistoryError({ reason: "changed" });
    const ref = refs[index];
    if (!ref)
      return {
        operation: "search",
        matches: [],
        examinedItems: 0,
        nextCursor: null,
      } satisfies ExternalHistoryResponse;
    const nextThread = () =>
      refs[index + 1]
        ? encodeSearchCursor({
            v: 2,
            sourceId: input.sourceId,
            query: input.query,
            filterCwd: input.filterCwd ?? null,
            afterKey: refs[index + 1]!.key,
            itemOffset: 0,
            version: null,
          })
        : null;
    const thread = yield* store.loadThread(ref);
    if (
      thread.origin === "t3" ||
      (input.filterCwd &&
        (thread.cwd === null ||
          normalizeProjectPathForComparison(thread.cwd) !==
            normalizeProjectPathForComparison(input.filterCwd)))
    )
      return {
        operation: "search",
        matches: [],
        examinedItems: 0,
        nextCursor: nextThread(),
      } satisfies ExternalHistoryResponse;
    const offset = cursor?.version === thread.version ? cursor.itemOffset : 0;
    if (offset > thread.items.length) return yield* invalidCursor();
    const end = Math.min(thread.items.length, offset + 20);
    const pattern = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
    const matches: ExternalHistoryMatch[] = [];
    for (const item of thread.items.slice(offset, end)) {
      const match = pattern.exec(item.text);
      if (!match) continue;
      let start = Math.max(0, match.index - 200);
      if (!isTextBoundary(item.text, start)) start--;
      const readCursor = encodeReadCursor({
        v: 2,
        sourceId: input.sourceId,
        key: ref.key,
        version: thread.version,
        itemId: item.id,
      });
      if (readCursor.length > 16_384 || item.id.length > 512)
        return yield* new ExternalHistoryError({ reason: "limit_exceeded" });
      matches.push({
        ref: {
          sourceId: input.sourceId,
          threadId: ref.key,
          readCursor,
          digest: yield* digest(evidence(item)),
        },
        threadTitle: thread.title,
        itemId: item.id,
        role: item.role,
        excerpt: item.text.slice(start, boundedTextEnd(item.text, start, 2_000)),
        textOffset: start,
        totalChars: item.text.length,
      });
    }
    return {
      operation: "search",
      matches,
      examinedItems: end - offset,
      nextCursor:
        end < thread.items.length
          ? encodeSearchCursor({
              v: 2,
              sourceId: input.sourceId,
              query: input.query,
              filterCwd: input.filterCwd ?? null,
              afterKey: ref.key,
              itemOffset: end,
              version: thread.version,
            })
          : nextThread(),
    } satisfies ExternalHistoryResponse;
  });
  const read = Effect.fn("ExternalHistory.readLocal")(function* (
    store: LocalHistoryStore,
    input: Extract<ExternalHistoryRequest, { operation: "read" }>,
  ) {
    const cursor = yield* decodeReadCursor(input.ref.readCursor).pipe(
      Effect.mapError(invalidCursor),
    );
    if (cursor.sourceId !== input.ref.sourceId || cursor.key !== input.ref.threadId)
      return yield* invalidCursor();
    const ref: LocalThreadRef = { key: cursor.key, version: cursor.version, updatedAt: 0 };
    const thread = yield* store.loadThread(ref);
    const item = thread.items.find((item) => item.id === cursor.itemId);
    if (
      thread.version !== cursor.version ||
      thread.origin === "t3" ||
      !item ||
      (yield* digest(evidence(item))) !== input.ref.digest
    )
      return yield* new ExternalHistoryError({ reason: "changed" });
    const start = input.textOffset ?? 0;
    if (start > item.text.length || !isTextBoundary(item.text, start))
      return yield* invalidCursor();
    const end = boundedTextEnd(item.text, start, input.maxChars ?? 12_000);
    return {
      operation: "read",
      ref: input.ref,
      threadTitle: thread.title,
      role: item.role,
      text: item.text.slice(start, end),
      textOffset: start,
      totalChars: item.text.length,
      nextTextOffset: end < item.text.length ? end : null,
    } satisfies ExternalHistoryResponse;
  });
  return { search, read, cache };
});
