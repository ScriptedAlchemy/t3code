import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ExternalHistoryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { TranscriptItem } from "../agentTranscripts.ts";
import { makeLocalHistory } from "./LocalHistory.ts";
import type { LocalHistoryStore, LocalThread } from "./LocalHistoryStore.ts";

const isHistoryError = Schema.is(ExternalHistoryError);
const item = (id: string, text: string): TranscriptItem => ({ id, role: "user", text });
const thread = (items: ReadonlyArray<TranscriptItem>): LocalThread => ({
  version: "v1",
  title: "Conversation",
  cwd: null,
  items,
});

const makeStore = (
  threads: ReadonlyArray<readonly [string, LocalThread | ExternalHistoryError]>,
  mightMention?: (key: string) => boolean,
) => {
  const loaded: string[] = [];
  const store: LocalHistoryStore = {
    listThreads: Effect.succeed(
      threads.map(([key], index) => ({ key, updatedAt: threads.length - index, version: "v1" })),
    ),
    loadThread: (ref) => {
      loaded.push(ref.key);
      const entry = threads.find(([key]) => key === ref.key)![1];
      return isHistoryError(entry) ? Effect.fail(entry) : Effect.succeed(entry);
    },
    nativeSessionId: (ref) => ref.key,
    ...(mightMention ? { mightMention: (ref) => Effect.succeed(mightMention(ref.key)) } : {}),
  };
  return { store, loaded };
};

const searchAll = Effect.fn("LocalHistory.test.searchAll")(function* (
  store: LocalHistoryStore,
  query: string,
) {
  const history = yield* makeLocalHistory;
  const found: string[] = [];
  let requests = 0;
  let cursor: string | undefined;
  do {
    const page = yield* history.search(store, {
      operation: "search",
      sourceId: "local",
      query,
      ...(cursor ? { cursor } : {}),
    });
    requests++;
    found.push(...page.matches.map((match) => `${match.ref.threadId}:${match.itemId}`));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { found, requests };
});

it.layer(NodeCrypto.layer)("local history search paging", (it) => {
  it.effect("returns a hit in the 300th thread from one request", () =>
    Effect.gen(function* () {
      const { store, loaded } = makeStore(
        Array.from({ length: 400 }, (_, index) => [
          `thread-${index}`,
          thread([item("only", index === 299 ? "the needle" : "nothing here")]),
        ]),
      );
      const history = yield* makeLocalHistory;
      const page = yield* history.search(store, {
        operation: "search",
        sourceId: "local",
        query: "needle",
      });
      expect(page.matches.map((match) => match.ref.threadId)).toEqual(["thread-299"]);
      expect(page.examinedItems).toBe(400);
      expect(loaded).toHaveLength(400);
      expect(page.nextCursor).toBeNull();
    }),
  );

  it.effect("resumes at the match cap and the text budget without skipping or repeating", () =>
    Effect.gen(function* () {
      const crowded = Array.from({ length: 45 }, (_, index) => item(`hit-${index}`, "needle"));
      const heavy = (key: string) =>
        [key, thread([item("padding", "x".repeat(2_500_000)), item("hit", "needle")])] as const;
      const { store } = makeStore([
        ["crowded", thread(crowded)],
        heavy("heavy-0"),
        heavy("heavy-1"),
        heavy("heavy-2"),
        heavy("heavy-3"),
        ["last", thread([item("hit", "needle")])],
      ]);
      const { found, requests } = yield* searchAll(store, "needle");
      expect(found).toEqual([
        ...crowded.map((entry) => `crowded:${entry.id}`),
        "heavy-0:hit",
        "heavy-1:hit",
        "heavy-2:hit",
        "heavy-3:hit",
        "last:hit",
      ]);
      expect(requests).toBeGreaterThan(3);
    }),
  );

  it.effect("skips unreadable threads and threads the store rules out without loading them", () =>
    Effect.gen(function* () {
      const { store, loaded } = makeStore(
        [
          ["broken", new ExternalHistoryError({ reason: "unsupported" })],
          ["unreadable", new ExternalHistoryError({ reason: "unavailable" })],
          ["live", new ExternalHistoryError({ reason: "changed" })],
          ["ruled-out", thread([item("hit", "needle")])],
          ["good", thread([item("hit", "needle")])],
        ],
        (key) => key !== "ruled-out",
      );
      const { found, requests } = yield* searchAll(store, "needle");
      expect(found).toEqual(["good:hit"]);
      expect(requests).toBe(1);
      expect(loaded).toEqual(["broken", "unreadable", "live", "good"]);
    }),
  );

  it.effect("skips sessions T3 owns without loading them, using one lookup per request", () =>
    Effect.gen(function* () {
      const { store, loaded } = makeStore([
        ["owned-a", thread([item("hit", "needle")])],
        ["mine", thread([item("hit", "needle")])],
        ["owned-b", thread([item("hit", "needle")])],
      ]);
      const lookups: Array<ReadonlyArray<string>> = [];
      const history = yield* makeLocalHistory;
      const page = yield* history.search(
        store,
        { operation: "search", sourceId: "local", query: "needle" },
        (ids) =>
          Effect.sync(() => {
            lookups.push(ids);
            return new Set(ids.filter((id) => id.startsWith("owned")));
          }),
      );
      expect(page.matches.map((match) => match.ref.threadId)).toEqual(["mine"]);
      expect(loaded).toEqual(["mine"]);
      expect(lookups).toEqual([["owned-a", "mine", "owned-b"]]);
    }),
  );
});
