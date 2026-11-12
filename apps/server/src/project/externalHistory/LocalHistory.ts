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
const SEARCH_MATCHES = 20;
// Set from measurement against ~1,800 real sessions; see the commit message.
const SEARCH_CHAR_BUDGET = 4_000_000;
const SEARCH_THREAD_BUDGET = 2_000;
// Oversized sessions fail only after about half a second of parsing.
const FAILED_LOAD_CHARS = 1_000_000;
// One unreadable or live-changing session must not end a search across everything else.
const SKIPPED_THREAD_REASONS: ReadonlySet<string> = new Set([
  "unsupported",
  "limit_exceeded",
  "missing",
  "changed",
]);
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
    const first =
      cursor?.afterKey == null ? 0 : refs.findIndex((ref) => ref.key === cursor.afterKey);
    if (first < 0) return yield* new ExternalHistoryError({ reason: "changed" });
    const cursorAt = (index: number, itemOffset: number, version: string | null) => {
      const ref = refs[index];
      return ref
        ? encodeSearchCursor({
            v: 2,
            sourceId: input.sourceId,
            query: input.query,
            filterCwd: input.filterCwd ?? null,
            afterKey: ref.key,
            itemOffset,
            version,
          })
        : null;
    };
    const pattern = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
    const matches: ExternalHistoryMatch[] = [];
    let examinedItems = 0;
    let examinedChars = 0;
    let visited = 0;
    for (let index = first; index < refs.length; index++) {
      if (examinedChars >= SEARCH_CHAR_BUDGET || visited >= SEARCH_THREAD_BUDGET)
        return {
          operation: "search",
          matches,
          examinedItems,
          nextCursor: cursorAt(index, 0, null),
        } satisfies ExternalHistoryResponse;
      visited++;
      const ref = refs[index]!;
      const resumed = index === first ? cursor : undefined;
      if (
        !resumed?.itemOffset &&
        store.mightMention &&
        !(yield* store.mightMention(ref, input.query))
      )
        continue;
      const thread = yield* store.loadThread(ref).pipe(
        Effect.catchIf(
          (error) => SKIPPED_THREAD_REASONS.has(error.reason),
          () => Effect.undefined,
        ),
      );
      if (!thread) {
        examinedChars += FAILED_LOAD_CHARS;
        continue;
      }
      examinedChars += thread.items.reduce((sum, item) => sum + item.text.length, 0);
      if (
        thread.origin === "t3" ||
        (input.filterCwd &&
          (thread.cwd === null ||
            normalizeProjectPathForComparison(thread.cwd) !==
              normalizeProjectPathForComparison(input.filterCwd)))
      )
        continue;
      const offset = resumed?.version === thread.version ? resumed.itemOffset : 0;
      if (offset > thread.items.length) return yield* invalidCursor();
      for (let position = offset; position < thread.items.length; position++) {
        const item = thread.items[position]!;
        examinedItems++;
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
        if (matches.length === SEARCH_MATCHES)
          return {
            operation: "search",
            matches,
            examinedItems,
            nextCursor:
              position + 1 < thread.items.length
                ? cursorAt(index, position + 1, thread.version)
                : cursorAt(index + 1, 0, null),
          } satisfies ExternalHistoryResponse;
      }
    }
    return {
      operation: "search",
      matches,
      examinedItems,
      nextCursor: null,
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
