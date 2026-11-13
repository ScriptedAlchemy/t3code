import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
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
        expect(
          (yield* history.search(store, { ...paged, cursor: second.nextCursor! }).pipe(Effect.flip))
            .reason,
        ).toBe("changed");
        expect(
          (yield* store
            .loadThread({ key: "../../outside.jsonl", version: "", updatedAt: 0 })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid_cursor");
      }).pipe(Effect.scoped),
  );

  it.effect("keeps valid messages around malformed and undecodable records", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const project = `${root}/projects/project`;
      yield* fs.makeDirectory(project, { recursive: true });
      const message = (uuid: string, content = "needle") =>
        JSON.stringify({ type: "user", uuid, message: { content } });
      yield* fs.writeFileString(
        `${project}/session.jsonl`,
        [
          message("before"),
          '{"type":"user",',
          JSON.stringify({ type: "progress", timestamp: 42 }),
          JSON.stringify({ type: "user", message: { content: "missing ID" } }),
          message("before", "needle updated"),
          message("after"),
        ].join("\n"),
      );
      const history = yield* makeLocalHistory;
      const store = yield* makeClaudeHistoryStore(root, history.cache);
      const page = yield* history.search(store, {
        operation: "search",
        sourceId: "claude",
        query: "needle",
      });
      expect(page.matches.map((match) => match.itemId)).toEqual(["before", "after"]);
      expect(
        (yield* history.read(store, { operation: "read", ref: page.matches[0]!.ref })).text,
      ).toBe("needle updated");
      yield* fs.writeFileString(`${project}/session.jsonl`, '{"unrelated":"data"}\nnot JSON');
      const [ref] = yield* store.listThreads;
      expect((yield* store.loadThread(ref!).pipe(Effect.flip)).reason).toBe("unsupported");
    }).pipe(Effect.scoped),
  );

  it.effect("isolates unreadable entries and retries incomplete listings after recovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const directory = `${root}/projects`;
      for (const project of ["good", "blocked"]) {
        yield* fs.makeDirectory(`${directory}/${project}`, { recursive: true });
        yield* fs.writeFileString(
          `${directory}/${project}/session.jsonl`,
          JSON.stringify({ type: "user", uuid: project, message: { content: "needle" } }) + "\n",
        );
      }
      const history = yield* makeLocalHistory;
      const allKeys = ["blocked/session.jsonl", "good/session.jsonl"];
      for (const failure of [
        { method: "stat", path: `${directory}/blocked`, reason: "NotFound" },
        { method: "readDirectory", path: `${directory}/blocked`, reason: "PermissionDenied" },
        { method: "stat", path: `${directory}/blocked/session.jsonl`, reason: "NotFound" },
        { method: "stat", path: `${directory}/blocked/session.jsonl`, reason: "PermissionDenied" },
      ] as const) {
        let unavailable = true;
        const error = PlatformError.systemError({
          _tag: failure.reason,
          module: "FileSystem",
          method: failure.method,
          pathOrDescriptor: failure.path,
        });
        const partialFs = FileSystem.make({
          ...fs,
          stat: (path) =>
            unavailable && failure.method === "stat" && path === failure.path
              ? Effect.fail(error)
              : fs.stat(path),
          readDirectory: (path) =>
            unavailable && failure.method === "readDirectory" && path === failure.path
              ? Effect.fail(error)
              : fs.readDirectory(path),
        });
        const store = yield* makeClaudeHistoryStore(root, history.cache).pipe(
          Effect.provideService(FileSystem.FileSystem, partialFs),
        );
        expect((yield* store.listThreads).map((ref) => ref.key)).toEqual(["good/session.jsonl"]);
        unavailable = false;
        expect((yield* store.listThreads).map((ref) => ref.key).toSorted()).toEqual(allKeys);
        if (failure.method === "stat") {
          unavailable = true;
          expect((yield* store.listThreads).map((ref) => ref.key)).toEqual(["good/session.jsonl"]);
          unavailable = false;
          expect((yield* store.listThreads).map((ref) => ref.key).toSorted()).toEqual(allKeys);
        }
      }
      const inaccessibleRoot = yield* makeClaudeHistoryStore(root, history.cache).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.make({
            ...fs,
            readDirectory: (path) =>
              path === directory
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "readDirectory",
                      pathOrDescriptor: path,
                    }),
                  )
                : fs.readDirectory(path),
          }),
        ),
      );
      expect((yield* inaccessibleRoot.listThreads.pipe(Effect.flip)).reason).toBe("unavailable");
    }).pipe(Effect.scoped),
  );

  it.effect("searches sessions larger than the old allocation cap and verifies their source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const project = `${root}/projects/project`;
      yield* fs.makeDirectory(project, { recursive: true });
      const file = `${project}/large.jsonl`;
      for (let index = 0; index < 34; index++) {
        yield* fs.writeFileString(
          file,
          JSON.stringify({
            type: "assistant",
            uuid: `large-${index}`,
            message: { content: "x".repeat(1024 * 1024) },
          }) + "\n",
          { flag: index === 0 ? "w" : "a" },
        );
      }
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          type: "user",
          uuid: "match",
          message: { content: "needle in a large session" },
        }) + "\n",
        { flag: "a" },
      );
      const history = yield* makeLocalHistory;
      const store = yield* makeClaudeHistoryStore(root, history.cache);
      const page = yield* history.search(store, {
        operation: "search",
        sourceId: "claude",
        query: "needle",
      });
      expect(page.matches.map((match) => match.itemId)).toEqual(["match"]);
      const ref = page.matches[0]!.ref;
      expect((yield* history.read(store, { operation: "read", ref })).text).toBe(
        "needle in a large session",
      );
      expect(
        (yield* history
          .read(store, { operation: "read", ref: { ...ref, digest: "0".repeat(64) } })
          .pipe(Effect.flip)).reason,
      ).toBe("changed");
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
      for (const [encoded, query] of [
        [String.raw`\u006e\u0065\u0065\u0064\u006c\u0065`, "needle"],
        [String.raw`left\/right`, "left/right"],
        ["Kſ", "ks"],
      ] as const) {
        yield* fs.writeFileString(`${project}/session.jsonl`, `${head}${encoded}"}}\n`);
        const page = yield* history.search(claude, {
          operation: "search",
          sourceId: "claude",
          query,
        });
        expect(page.matches.map((match) => match.itemId)).toEqual(["split"]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("refreshes newest-first order when an existing session is appended", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const project = `${root}/projects/project`;
      yield* fs.makeDirectory(project, { recursive: true });
      const message = (uuid: string) =>
        JSON.stringify({ type: "user", uuid, message: { content: "needle" } }) + "\n";
      for (const [name, modified] of [
        ["older", 1],
        ["newer", 2],
      ] as const) {
        yield* fs.writeFileString(`${project}/${name}.jsonl`, message(name));
        yield* fs.utimes(`${project}/${name}.jsonl`, modified, modified);
      }
      const history = yield* makeLocalHistory;
      const store = yield* makeClaudeHistoryStore(root, history.cache);
      const request = { operation: "search", sourceId: "claude", query: "needle" } as const;
      expect((yield* history.search(store, request)).matches.map((match) => match.itemId)).toEqual([
        "newer",
        "older",
      ]);
      yield* fs.writeFileString(`${project}/older.jsonl`, message("appended"), { flag: "a" });
      yield* fs.utimes(`${project}/older.jsonl`, 3, 3);
      expect((yield* history.search(store, request)).matches.map((match) => match.itemId)).toEqual([
        "older",
        "appended",
        "newer",
      ]);
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
      expect(
        (yield* history.search(
          pi,
          { operation: "search", sourceId: "pi", query: "needle" },
          (ids) => Effect.succeed(new Set(ids.filter((id) => id === piFile))),
        )).matches,
      ).toEqual([]);
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
