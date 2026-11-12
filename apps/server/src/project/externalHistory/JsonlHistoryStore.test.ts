import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { makeClaudeHistoryStore, makePiHistoryStore } from "./JsonlHistoryStore.ts";
import { makeLocalHistory } from "./LocalHistory.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("local JSONL histories", (it) => {
  it.effect(
    "finds old Claude evidence before the import window and preserves verified native IDs without re-enumeration",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const project = `${root}/projects/project`;
        yield* fs.makeDirectory(project, { recursive: true });
        const file = `${project}/session.jsonl`;
        const records = [
          {
            type: "user",
            uuid: "old-evidence",
            sessionId: "session",
            cwd: "/project",
            timestamp: "2020-01-01T00:00:00Z",
            message: { content: "needle from the distant past" },
          },
          ...Array.from({ length: 230 }, (_, index) => ({
            type: "assistant",
            uuid: `new-${index}`,
            message: { content: `Other message ${index}` },
          })),
          { type: "custom-title", customTitle: "Renamed" },
          { type: "ai-title", aiTitle: "Generated" },
        ];
        yield* fs.writeFileString(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
        let enumerations = 0;
        const counting = FileSystem.make({
          ...fs,
          readDirectory: (path) => {
            enumerations++;
            return fs.readDirectory(path);
          },
        });
        const history = yield* makeLocalHistory;
        const store = yield* makeClaudeHistoryStore(root, history.cache).pipe(
          Effect.provideService(FileSystem.FileSystem, counting),
        );
        const request = {
          operation: "search",
          sourceId: "claude",
          query: "needle",
          filterCwd: "/project",
        } as const;
        const first = yield* history.search(store, request);
        expect(first.matches.map((m) => m.itemId)).toEqual(["old-evidence"]);
        expect(first.matches[0]?.threadTitle).toBe("Renamed");
        expect(first.nextCursor).toBeNull();
        const enumerated = enumerations;
        const paged = { ...request, query: "Other message" };
        const pageOne = yield* history.search(store, paged);
        const second = yield* history.search(store, { ...paged, cursor: pageOne.nextCursor! });
        expect(second.examinedItems).toBe(20);
        const read = yield* history.read(store, { operation: "read", ref: first.matches[0]!.ref });
        expect(read.text).toBe("needle from the distant past");
        expect(enumerations).toBe(enumerated);
        expect(
          (yield* history
            .read(store, {
              operation: "read",
              ref: { ...first.matches[0]!.ref, digest: "0".repeat(64) },
            })
            .pipe(Effect.flip)).reason,
        ).toBe("changed");
        yield* fs.writeFileString(
          file,
          records.map((r) => JSON.stringify(r)).join("\n") +
            "\n" +
            JSON.stringify({
              type: "assistant",
              uuid: "append",
              message: { content: "needle appended" },
            }) +
            "\n",
        );
        expect(
          (yield* history
            .read(store, { operation: "read", ref: first.matches[0]!.ref })
            .pipe(Effect.flip)).reason,
        ).toBe("changed");
        const restarted = yield* history.search(store, { ...paged, cursor: second.nextCursor! });
        expect(restarted.matches[0]?.itemId).toBe("new-0");
        expect(
          (yield* store
            .loadThread({ key: "../../outside.jsonl", version: "", updatedAt: 0 })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid_cursor");
      }).pipe(Effect.scoped),
  );

  it.effect("finds queries split across read chunks and queries that JSON escapes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const project = `${root}/projects/project`;
      yield* fs.makeDirectory(project, { recursive: true });
      const head = '{"type":"user","uuid":"split","message":{"content":"';
      const text = "x".repeat(1024 * 1024 - head.length - 3) + 'needle then say "hi"';
      yield* fs.writeFileString(
        `${project}/session.jsonl`,
        JSON.stringify({ type: "user", uuid: "split", message: { content: text } }) + "\n",
      );
      const history = yield* makeLocalHistory;
      const claude = yield* makeClaudeHistoryStore(root, history.cache);
      for (const query of ["needle", 'say "hi"']) {
        expect(
          (yield* history.search(claude, { operation: "search", sourceId: "claude", query }))
            .matches,
        ).toHaveLength(1);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("excludes T3 Claude sessions and follows the active Pi branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const project = `${root}/projects/project`;
      yield* fs.makeDirectory(project, { recursive: true });
      yield* fs.writeFileString(
        `${project}/t3.jsonl`,
        JSON.stringify({
          type: "user",
          uuid: "t3",
          entrypoint: "t3-code",
          message: { content: "needle" },
        }) + "\n",
      );
      const history = yield* makeLocalHistory;
      const claude = yield* makeClaudeHistoryStore(root, history.cache);
      expect(
        (yield* history.search(claude, {
          operation: "search",
          sourceId: "claude",
          query: "needle",
        })).matches,
      ).toEqual([]);
      const sessions = `${root}/sessions/project`;
      yield* fs.makeDirectory(sessions, { recursive: true });
      const piFile = `${sessions}/pi.jsonl`;
      yield* fs.writeFileString(
        piFile,
        [
          { type: "session", id: "pi", cwd: "/project" },
          {
            type: "message",
            id: "user",
            parentId: null,
            message: { role: "user", content: "Question" },
          },
          {
            type: "message",
            id: "abandoned",
            parentId: "user",
            message: { role: "assistant", content: "needle abandoned" },
          },
          {
            type: "message",
            id: "active",
            parentId: "user",
            message: { role: "assistant", content: "needle active" },
          },
          { type: "session_info", id: "name", parentId: "active", name: "Pi renamed" },
        ]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      );
      const pi = yield* makePiHistoryStore(`${root}/sessions`, history.cache);
      const page = yield* history.search(pi, {
        operation: "search",
        sourceId: "pi",
        query: "needle",
      });
      expect(page.matches.map((m) => m.itemId)).toEqual(["active"]);
      expect(page.matches[0]?.threadTitle).toBe("Pi renamed");
      yield* fs.writeFileString(
        piFile,
        JSON.stringify({ type: "message", message: { role: "user", content: "legacy" } }) + "\n",
      );
      expect(
        (yield* history.search(pi, { operation: "search", sourceId: "pi", query: "legacy" }))
          .matches,
      ).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
