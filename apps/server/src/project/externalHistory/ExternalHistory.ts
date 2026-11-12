import {
  ExternalHistoryError,
  type ExternalHistoryRequest,
  type ExternalHistoryResponse,
  type ExternalHistorySource,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type {
  ProviderNativeHistory,
  ProviderNativeHistoryError,
} from "@t3tools/provider-core/server/nativeHistory";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import { makeChatGptExportStore } from "./ChatGptExportHistory.ts";
import { makeLocalHistory } from "./LocalHistory.ts";
import type { LocalHistoryStore } from "./LocalHistoryStore.ts";

export class ExternalHistory extends Context.Service<
  ExternalHistory,
  {
    readonly query: (
      input: ExternalHistoryRequest,
    ) => Effect.Effect<ExternalHistoryResponse, ExternalHistoryError>;
  }
>()("t3/project/externalHistory/ExternalHistory") {}

const NativeCursor = Schema.Struct({
  version: Schema.Literal(1),
  sourceId: Schema.String,
  query: Schema.String,
  filterCwd: Schema.NullOr(Schema.String),
  includeArchived: Schema.Boolean,
  archived: Schema.Boolean,
  listCursor: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  itemCursor: Schema.NullOr(Schema.String),
});
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeCursor));
const encodeCursorValue = Schema.encodeSync(Schema.fromJsonString(NativeCursor));
const encodeCursor = (cursor: typeof NativeCursor.Type) =>
  Effect.suspend(() => {
    const encoded = encodeCursorValue(cursor);
    return encoded.length <= 16_384
      ? Effect.succeed(encoded)
      : Effect.fail(new ExternalHistoryError({ reason: "limit_exceeded" }));
  });
const encodeFingerprint = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeIdentity = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      driverKind: Schema.String,
      continuationKey: Schema.String,
    }),
  ),
);

type Source = { readonly info: ExternalHistorySource } & (
  | { readonly _tag: "native"; readonly native: ProviderNativeHistory; readonly readers: number }
  | { readonly _tag: "local"; readonly store: LocalHistoryStore }
);

// A signed-out or older instance must not hide a shared home that another enabled instance
// can read. Retry only availability/capability failures, never evidence or cursor mismatches.
function alternateNativeReader(
  first: ProviderNativeHistory,
  second: ProviderNativeHistory,
): ProviderNativeHistory {
  const fallback = <A>(
    primary: Effect.Effect<A, ProviderNativeHistoryError>,
    secondary: () => Effect.Effect<A, ProviderNativeHistoryError>,
  ) =>
    primary.pipe(
      Effect.catchIf(
        (error) => error.reason === "unavailable" || error.reason === "unsupported",
        () => secondary(),
      ),
    );
  return {
    list: (input) => fallback(first.list(input), () => second.list(input)),
    items: (input) => fallback(first.items(input), () => second.items(input)),
    readSource: (input) => fallback(first.readSource(input), () => second.readSource(input)),
  };
}

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Digest.Digest;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const local = yield* makeLocalHistory;
  let localCatalog = new Map<string, Source>();
  let fingerprint: string | undefined;
  const digest = (text: string) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(text)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError((cause) => new ExternalHistoryError({ reason: "unavailable", cause })),
    );

  const sources = Effect.fn("ExternalHistory.sources")(function* (refresh: boolean) {
    const value = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new ExternalHistoryError({ reason: "unavailable", cause })),
    );
    if (!value.externalHistory.enabled) {
      localCatalog = new Map();
      fingerprint = undefined;
      return { enabled: false, sources: [] as Array<Source> };
    }
    const result = new Map<string, Source>();
    for (const instance of yield* registry.listInstances) {
      if (!instance.enabled || instance.driverKind !== "codex" || !instance.nativeHistory) continue;
      const id = `codex:${yield* digest(encodeIdentity(instance.continuationIdentity))}`;
      const existing = result.get(id);
      if (existing?._tag === "native" && existing.readers < 3) {
        result.set(id, {
          ...existing,
          native: alternateNativeReader(existing.native, instance.nativeHistory),
          readers: existing.readers + 1,
        });
      } else if (existing === undefined)
        result.set(id, {
          _tag: "native",
          info: {
            id,
            label: instance.displayName ?? "Codex",
            kind: "codex",
            provider: ProviderDriverKind.make("codex"),
            capabilities: { cwdFilter: true, archived: true },
            status: "ready",
          },
          native: instance.nativeHistory,
          readers: 1,
        });
    }
    const nextFingerprint = encodeFingerprint([value.externalHistory, value.providerInstances]);
    if (refresh || fingerprint !== nextFingerprint) {
      const next = new Map<string, Source>();
      for (const configured of value.externalHistory.chatGptExportPaths) {
        const filePath = path.resolve(config.cwd, configured);
        const id = `chatgpt:${yield* digest(filePath)}`;
        next.set(
          id,
          localCatalog.get(id) ?? {
            _tag: "local",
            info: {
              id,
              label: `ChatGPT · ${path.basename(filePath)}`,
              kind: "chatgpt_export",
              capabilities: { cwdFilter: false, archived: false },
              status: "ready",
            },
            store: yield* makeChatGptExportStore(filePath, local.cache).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
            ),
          },
        );
      }
      localCatalog = next;
      fingerprint = nextFingerprint;
    }
    for (const [id, source] of localCatalog) result.set(id, source);
    return { enabled: true, sources: [...result.values()] };
  });

  const nativeSearch = Effect.fn("ExternalHistory.nativeSearch")(function* (
    source: Extract<Source, { _tag: "native" }>,
    input: Extract<ExternalHistoryRequest, { operation: "search" }>,
  ) {
    const decoded =
      input.cursor === undefined
        ? undefined
        : yield* decodeCursor(input.cursor).pipe(
            Effect.mapError(() => new ExternalHistoryError({ reason: "invalid_cursor" })),
          );
    let cursor: typeof NativeCursor.Type = decoded ?? {
      version: 1,
      sourceId: source.info.id,
      query: input.query,
      filterCwd: input.filterCwd ?? null,
      includeArchived: input.includeArchived ?? false,
      archived: false,
      listCursor: null,
      threadId: null,
      itemCursor: null,
    };
    if (
      cursor.sourceId !== source.info.id ||
      cursor.query !== input.query ||
      cursor.filterCwd !== (input.filterCwd ?? null) ||
      cursor.includeArchived !== (input.includeArchived ?? false) ||
      (cursor.archived && !cursor.includeArchived)
    )
      return yield* new ExternalHistoryError({ reason: "invalid_cursor" });
    const afterPhase = () =>
      cursor.includeArchived && !cursor.archived
        ? encodeCursor({
            ...cursor,
            archived: true,
            listCursor: null,
            threadId: null,
            itemCursor: null,
          })
        : Effect.succeed(null);
    if (cursor.threadId === null) {
      const page = yield* source.native
        .list({
          cwd: config.cwd,
          archived: cursor.archived,
          limit: 1,
          ...(cursor.filterCwd === null ? {} : { filterCwd: cursor.filterCwd }),
          ...(cursor.listCursor === null ? {} : { cursor: cursor.listCursor }),
        })
        .pipe(
          Effect.mapError((cause) => new ExternalHistoryError({ reason: cause.reason, cause })),
        );
      if (page.threads.length > 1)
        return yield* new ExternalHistoryError({ reason: "unsupported" });
      const thread = page.threads[0];
      if (!thread)
        return {
          operation: "search",
          matches: [],
          examinedItems: 0,
          nextCursor: yield* page.nextCursor === null
            ? afterPhase()
            : encodeCursor({ ...cursor, listCursor: page.nextCursor }),
        } satisfies ExternalHistoryResponse;
      cursor = { ...cursor, threadId: thread.nativeThreadId, listCursor: page.nextCursor };
    }
    const page = yield* source.native
      .items({
        cwd: config.cwd,
        nativeThreadId: cursor.threadId!,
        query: input.query,
        limit: 20,
        maxCharsPerItem: 2_000,
        ...(cursor.itemCursor === null ? {} : { cursor: cursor.itemCursor }),
      })
      .pipe(Effect.mapError((cause) => new ExternalHistoryError({ reason: cause.reason, cause })));
    const nextCursor = yield* page.nextCursor !== null
      ? encodeCursor({ ...cursor, itemCursor: page.nextCursor })
      : cursor.listCursor !== null
        ? encodeCursor({ ...cursor, threadId: null, itemCursor: null })
        : afterPhase();
    return {
      operation: "search",
      examinedItems: page.examinedItems,
      nextCursor,
      matches: page.items.map((item) => ({
        ref: {
          sourceId: source.info.id,
          threadId: page.thread.nativeThreadId,
          readCursor: item.readCursor,
          digest: item.digest,
        },
        threadTitle: page.thread.title,
        itemId: item.nativeItemId,
        role: item.role,
        excerpt: item.text,
        textOffset: item.textOffset,
        totalChars: item.totalChars,
      })),
    } satisfies ExternalHistoryResponse;
  });

  const query = Effect.fn("ExternalHistory.query")(function* (
    input: ExternalHistoryRequest,
  ): Effect.fn.Return<ExternalHistoryResponse, ExternalHistoryError> {
    let current = yield* sources(input.operation === "sources");
    const requestedId =
      input.operation === "read"
        ? input.ref.sourceId
        : input.operation === "search"
          ? input.sourceId
          : undefined;
    if (
      current.enabled &&
      requestedId &&
      !current.sources.some((source) => source.info.id === requestedId)
    )
      current = yield* sources(true);
    if (input.operation === "sources")
      return {
        operation: "sources",
        enabled: current.enabled,
        sources: current.sources
          .map(({ info }) => info)
          .filter((info) => input.catalogVersion === 2 || info.kind !== "local_transcript"),
        unsupported: [],
      };
    if (!current.enabled) return yield* new ExternalHistoryError({ reason: "disabled" });
    const source = current.sources.find(
      (entry) =>
        entry.info.id === (input.operation === "read" ? input.ref.sourceId : input.sourceId),
    );
    if (!source) return yield* new ExternalHistoryError({ reason: "missing" });
    if (
      input.operation === "search" &&
      ((input.filterCwd && !source.info.capabilities.cwdFilter) ||
        (input.includeArchived && !source.info.capabilities.archived))
    )
      return yield* new ExternalHistoryError({ reason: "unsupported" });
    if (source._tag === "local")
      return yield* input.operation === "search"
        ? local.search(source.store, input)
        : local.read(source.store, input);
    if (input.operation === "search") return yield* nativeSearch(source, input);
    const result = yield* source.native
      .readSource({
        cwd: config.cwd,
        nativeThreadId: input.ref.threadId,
        readCursor: input.ref.readCursor,
        digest: input.ref.digest,
        ...(input.textOffset === undefined ? {} : { textOffset: input.textOffset }),
        ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
      })
      .pipe(Effect.mapError((cause) => new ExternalHistoryError({ reason: cause.reason, cause })));
    return {
      operation: "read",
      ref: input.ref,
      threadTitle: result.thread.title,
      role: result.item.role,
      text: result.item.text,
      textOffset: result.item.textOffset,
      totalChars: result.item.totalChars,
      nextTextOffset: result.nextTextOffset,
    };
  });
  return { query };
});

export const layer = Layer.effect(ExternalHistory, make);
