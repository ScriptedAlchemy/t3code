import {
  ExternalHistoryError,
  type ExternalHistoryRequest,
  type ExternalHistoryResponse,
  type ExternalHistorySource,
  ProviderDriverKind,
  ProviderInstanceId,
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
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { resolveOpenCodeDataDirs } from "@t3tools/provider-opencode/server/usage";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import { makeChatGptExportStore } from "./ChatGptExportHistory.ts";
import { makeLocalHistory } from "./LocalHistory.ts";
import { makeHistorySupport } from "./historySupport.ts";
import { makeClaudeHistoryStore, makePiHistoryStore } from "./JsonlHistoryStore.ts";
import { makeOpenCodeHistoryStore } from "./OpenCodeHistoryStore.ts";
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
  | { readonly _tag: "unavailable" }
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
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const catalogLock = yield* Semaphore.make(1);
  const excludedRoots = Effect.forEach(
    [config.baseDir, config.stateDir, path.join(home, ".t3"), path.join(home, "Downloads")],
    (dir) => fs.realPath(dir).pipe(Effect.orElseSucceed(() => path.resolve(dir))),
  );
  const inside = (root: string, parent: string) => {
    const relative = path.relative(parent, root);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  };
  const supportTable = makeHistorySupport({
    claudeAgent: makeClaudeHistoryStore,
    pi: makePiHistoryStore,
    opencode: makeOpenCodeHistoryStore,
    openCodeRoots: Effect.fn("ExternalHistory.openCodeRoots")(function* (env) {
      const roots: string[] = [];
      const excluded = yield* excludedRoots;
      for (const root of yield* resolveOpenCodeDataDirs(env)) {
        const canonical = yield* fs.realPath(root).pipe(Effect.option);
        if (Option.isNone(canonical) || excluded.some((parent) => inside(canonical.value, parent)))
          continue;
        const dir = canonical.value;
        const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
        const databases = names.filter((name) => /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(name));
        roots.push(...(databases.length ? databases.map((name) => path.join(dir, name)) : [dir]));
      }
      return roots;
    }),
  });
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
      if (supportTable[instance.driverKind]?.kind !== "native" || !instance.nativeHistory) continue;
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
      const excluded = yield* excludedRoots;
      const seen = new Set<string>();
      for (const [driver, support] of Object.entries(supportTable)) {
        if (support.kind !== "local") continue;
        const profiles = [
          {
            instanceId: ProviderInstanceId.make(driver),
            config: undefined,
            environment: undefined,
          },
          ...Object.entries(value.providerInstances)
            .filter(([, profile]) => profile.driver === driver)
            .map(([id, profile]) => ({
              instanceId: ProviderInstanceId.make(id),
              config: profile.config,
              environment: profile.environment,
            })),
        ];
        for (const profile of profiles) {
          const env = yield* mergeProviderInstanceEnvironment(
            profile.environment,
            environment,
          ).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
          const roots = yield* support
            .roots({
              instanceId: profile.instanceId,
              config: profile.config,
              environment: env,
              stateDir: config.stateDir,
            })
            .pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(HostProcess.HomeDirectory, home),
            );
          for (const root of roots) {
            const canonical = yield* fs.realPath(root).pipe(Effect.option);
            if (Option.isNone(canonical) || excluded.some((dir) => inside(canonical.value, dir)))
              continue;
            const stat = yield* fs.stat(canonical.value).pipe(Effect.option);
            if (Option.isNone(stat)) continue;
            const identity = `${driver}:${stat.value.dev}:${Option.map(stat.value.ino, String).pipe(Option.getOrElse(() => canonical.value))}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            const id = `local:${driver}:${yield* digest(canonical.value)}`;
            const existing = localCatalog.get(id);
            if (existing?._tag === "local") {
              next.set(id, existing);
              continue;
            }
            const opened = yield* support
              .open(canonical.value, local.cache)
              .pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.result,
              );
            if (opened._tag === "Failure" && opened.failure.reason === "missing") continue;
            const info: ExternalHistorySource = {
              id,
              label: `${support.label} · ${canonical.value}`,
              kind: "local_transcript",
              provider: ProviderDriverKind.make(driver),
              capabilities: { cwdFilter: true, archived: false },
              status:
                opened._tag === "Success"
                  ? "ready"
                  : opened.failure.reason === "unsupported"
                    ? "unsupported_format"
                    : "unavailable",
              ...(opened._tag === "Failure" ? { message: opened.failure.message } : {}),
            };
            next.set(
              id,
              opened._tag === "Success"
                ? { _tag: "local", info, store: opened.success }
                : { _tag: "unavailable", info },
            );
          }
        }
      }
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
  }, catalogLock.withPermit);

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
      if (thread.originator === "T3 Code")
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
        unsupported: Object.entries(supportTable).flatMap(([provider, support]) =>
          support.kind === "unsupported"
            ? [
                {
                  provider: ProviderDriverKind.make(provider),
                  label: support.label,
                  reason: support.reason,
                },
              ]
            : [],
        ),
      };
    if (!current.enabled) return yield* new ExternalHistoryError({ reason: "disabled" });
    const source = current.sources.find(
      (entry) =>
        entry.info.id === (input.operation === "read" ? input.ref.sourceId : input.sourceId),
    );
    if (!source) return yield* new ExternalHistoryError({ reason: "missing" });
    if (source._tag === "unavailable")
      return yield* new ExternalHistoryError({
        reason: source.info.status === "unsupported_format" ? "unsupported" : "unavailable",
      });
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
    if (result.thread.originator === "T3 Code")
      return yield* new ExternalHistoryError({ reason: "missing" });
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
