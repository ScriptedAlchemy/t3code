import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { makeOpenCodeHistoryStore } from "./OpenCodeHistoryStore.ts";
import { makeLocalHistory } from "./LocalHistory.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("OpenCode local history", (it) => {
  it.effect(
    "reads current-schema user, assistant and tool text without reasoning or database writes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const file = `${root}/opencode.db`;
        yield* Effect.sync(() => {
          const db = new NodeSqlite.DatabaseSync(file);
          try {
            db.exec(
              "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, parent_id TEXT, time_updated INTEGER); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT)",
            );
            db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)").run(
              "session",
              "/project",
              "OpenCode conversation",
              null,
              1,
            );
            const insert = db.prepare("INSERT INTO session_message VALUES (?, 'session', ?, ?, ?)");
            insert.run("user", "user", 0, JSON.stringify({ text: "needle user" }));
            insert.run(
              "assistant",
              "assistant",
              1,
              JSON.stringify({
                content: [
                  {
                    type: "reasoning",
                    text: "hidden needle reasoning",
                    native: { opaque: "x".repeat(20_000_000) },
                  },
                  { type: "text", text: "needle answer" },
                  {
                    type: "tool",
                    id: "call",
                    name: "read",
                    state: {
                      input: { path: "src/index.ts" },
                      content: [{ type: "text", text: "needle tool output" }],
                    },
                  },
                ],
              }),
            );
          } finally {
            db.close();
          }
        });
        const before = yield* fs.readFile(file);
        const history = yield* makeLocalHistory;
        const store = yield* makeOpenCodeHistoryStore(file, history.cache);
        const result = yield* history.search(store, {
          operation: "search",
          sourceId: "opencode",
          query: "needle",
        });
        expect(result.matches.map((m) => [m.itemId, m.role])).toEqual([
          ["user", "user"],
          ["assistant", "assistant"],
          ["assistant/tool/call", "tool"],
        ]);
        expect(result.matches.map((m) => m.excerpt).join("\n")).not.toContain("reasoning");
        expect(
          (yield* history.read(store, { operation: "read", ref: result.matches[2]!.ref })).text,
        ).toBe("read\nneedle tool output");
        expect(Buffer.from(yield* fs.readFile(file)).equals(Buffer.from(before))).toBe(true);
        expect(yield* fs.readDirectory(root)).toEqual(["opencode.db"]);
        yield* Effect.sync(() => {
          const db = new NodeSqlite.DatabaseSync(file);
          try {
            db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)").run(
              "unrelated",
              "/project",
              "Another conversation",
              null,
              2,
            );
          } finally {
            db.close();
          }
        });
        expect(
          (yield* history.read(store, { operation: "read", ref: result.matches[2]!.ref })).text,
        ).toBe("read\nneedle tool output");
        yield* Effect.sync(() => {
          const db = new NodeSqlite.DatabaseSync(file);
          try {
            db.prepare("UPDATE session_message SET data = ? WHERE id = 'user'").run(
              JSON.stringify({ text: "Changed" }),
            );
          } finally {
            db.close();
          }
        });
        expect(
          (yield* history
            .read(store, { operation: "read", ref: result.matches[0]!.ref })
            .pipe(Effect.flip)).reason,
        ).toBe("changed");
      }).pipe(Effect.scoped),
  );

  it.effect("does not let the raw JSON prefilter hide escaped or case-folded matches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const file = `${root}/opencode.db`;
      const samples = [
        ["unicode-escape", String.raw`\u006e\u0065\u0065\u0064\u006c\u0065`, "needle"],
        ["slash-escape", String.raw`left\/right`, "left/right"],
        ["unicode-fold", "Kſ", "ks"],
      ] as const;
      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(file);
        try {
          db.exec(
            "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, parent_id TEXT, time_updated INTEGER); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT)",
          );
          for (const [id, encoded] of samples) {
            db.prepare(
              "INSERT INTO session_v2 VALUES (?, '/project', 'Conversation', NULL, 1)",
            ).run(id);
            db.prepare("INSERT INTO session_message VALUES (?, ?, 'user', 0, ?)").run(
              id,
              id,
              `{"text":"${encoded}"}`,
            );
          }
        } finally {
          db.close();
        }
      });
      const history = yield* makeLocalHistory;
      const store = yield* makeOpenCodeHistoryStore(file, history.cache);
      for (const [id, , query] of samples) {
        const page = yield* history.search(store, {
          operation: "search",
          sourceId: "opencode",
          query,
        });
        expect(page.matches.map((match) => match.itemId)).toEqual([id]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("rejects older OpenCode databases as an unsupported format", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const file = `${root}/opencode.db`;
      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(file);
        try {
          db.exec("CREATE TABLE message (id TEXT, data TEXT)");
        } finally {
          db.close();
        }
      });
      const history = yield* makeLocalHistory;
      expect((yield* makeOpenCodeHistoryStore(file, history.cache).pipe(Effect.flip)).reason).toBe(
        "unsupported",
      );
    }).pipe(Effect.scoped),
  );
});
