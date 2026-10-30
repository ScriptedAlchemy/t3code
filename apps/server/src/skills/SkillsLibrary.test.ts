// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem has no lstat.
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerSettings from "../serverSettings.ts";
import * as SkillsLibrary from "./SkillsLibrary.ts";

const setup = Effect.fn("SkillsLibrary.test.setup")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-skills-library-" });
  const claude = path.join(home, ".claude", "skills");
  const codex = path.join(home, ".codex", "skills");
  const library = path.join(home, ".agents", "skills");
  yield* fs.makeDirectory(claude, { recursive: true });
  yield* fs.makeDirectory(codex, { recursive: true });
  const service = yield* SkillsLibrary.make.pipe(
    Effect.provide(ServerSettings.ServerSettingsService.layerTest()),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, { HOME: home }),
  );
  const skill = (root: string, name: string, body: string, frontmatterName = name) =>
    fs
      .makeDirectory(path.join(root, name), { recursive: true })
      .pipe(
        Effect.andThen(
          fs.writeFileString(
            path.join(root, name, "SKILL.md"),
            `---\nname: ${frontmatterName}\ndescription: test\n---\n${body}\n`,
          ),
        ),
      );
  const read = (root: string, name: string) => fs.readFileString(path.join(root, name, "SKILL.md"));
  const link = (root: string, name: string) =>
    fs.readLink(path.join(root, name)).pipe(Effect.orElseSucceed(() => undefined));
  return { fs, path, home, claude, codex, library, service, skill, read, link };
});

/** Every entry under `root`, links not followed, with what a write would change. */
const snapshot = (root: string) =>
  Effect.promise(async () => {
    const entries: Array<string> = [];
    const walk = async (directory: string) => {
      for (const name of (await NodeFSP.readdir(directory)).sort()) {
        const entry = `${directory}/${name}`;
        const info = await NodeFSP.lstat(entry);
        entries.push(`${entry} ${info.ino} ${info.mtimeMs}`);
        if (info.isDirectory()) await walk(entry);
      }
    };
    await walk(root);
    return entries;
  });

it.layer(NodeServices.layer)("SkillsLibrary", (it) => {
  describe("apply", () => {
    it.effect.skipIf(!symlinksSupported)(
      "keeps one copy of a skill two harnesses share and links it into both",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, claude, codex, library, service, skill, read, link } =
            yield* setup();
          yield* skill(claude, "shared", "same");
          yield* skill(codex, "shared", "same");
          yield* skill(claude, "claude-only", "claude");
          yield* skill(path.join(claude, "synced", "org_account"), "synced-skill", "synced");
          yield* skill(path.join(codex, ".system"), "bundled", "bundled");
          // A root that already is the library must not be emptied into itself.
          yield* fs.makeDirectory(path.join(home, ".gemini", "config"), { recursive: true });
          yield* fs.makeDirectory(path.dirname(library), { recursive: true });
          yield* fs.makeDirectory(library);
          yield* fs.symlink(library, path.join(home, ".gemini", "config", "skills"));

          yield* service.apply;

          expect((yield* fs.readDirectory(library)).sort()).toEqual(["claude-only", "shared"]);
          expect(yield* read(library, "shared")).toContain("same");
          for (const root of [claude, codex]) {
            expect(yield* link(root, "shared")).toBe(path.join(library, "shared"));
            expect(yield* link(root, "claude-only")).toBe(path.join(library, "claude-only"));
          }
          expect(yield* read(path.join(claude, "synced", "org_account"), "synced-skill")).toContain(
            "synced",
          );
          expect(yield* read(path.join(codex, ".system"), "bundled")).toContain("bundled");
          expect(yield* fs.readDirectory(path.join(codex, ".system"))).toEqual(["bundled"]);

          const status = yield* service.status;
          expect(status.libraryPath).toBe(library);
          expect(status.conflicts).toEqual([]);
          expect(status.linked).toEqual([
            { driver: "claudeAgent", name: "claude-only" },
            { driver: "claudeAgent", name: "shared" },
            { driver: "codex", name: "claude-only" },
            { driver: "codex", name: "shared" },
          ]);

          const before = yield* snapshot(home);
          yield* service.apply;
          expect(yield* snapshot(home)).toEqual(before);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "moves neither copy of a skill whose copies differ and reports both paths",
      () =>
        Effect.gen(function* () {
          const { path, claude, codex, library, service, skill, read, link } = yield* setup();
          yield* skill(claude, "review", "claude version");
          yield* skill(codex, "review", "codex version");
          yield* skill(codex, "other", "other");

          yield* service.apply;

          expect(yield* read(claude, "review")).toContain("claude version");
          expect(yield* read(codex, "review")).toContain("codex version");
          expect(yield* link(claude, "review")).toBeUndefined();
          expect(yield* link(claude, "other")).toBe(path.join(library, "other"));
          expect((yield* service.status).conflicts).toEqual([
            { name: "review", paths: [path.join(claude, "review"), path.join(codex, "review")] },
          ]);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reports a frontmatter name that differs from its folder",
      () =>
        Effect.gen(function* () {
          const { claude, service, skill } = yield* setup();
          yield* skill(claude, "deploy", "body", "ship-it");
          yield* skill(claude, "matching", "body");

          expect((yield* service.status).nameMismatches).toEqual([
            { name: "deploy", frontmatterName: "ship-it" },
          ]);
        }),
    );
  });

  describe("detach", () => {
    it.effect.skipIf(!symlinksSupported)(
      "restores real folders and removes only links into the library",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, claude, codex, library, service, skill, read, link } =
            yield* setup();
          yield* skill(claude, "hello", "hello");
          yield* skill(codex, "codex-only", "codex");
          yield* service.apply;
          const elsewhere = path.join(home, "dev", "skills");
          yield* skill(elsewhere, "mine", "mine");
          yield* fs.symlink(path.join(elsewhere, "mine"), path.join(claude, "mine"));
          // A crash after unlinking, before the rename, leaves only the staged copy.
          yield* fs.remove(path.join(claude, "codex-only"));
          yield* fs.copy(
            path.join(library, "codex-only"),
            path.join(claude, ".codex-only.t3-restore"),
          );

          yield* service.detach;
          yield* service.detach;

          for (const name of ["hello", "codex-only"]) {
            expect(yield* link(claude, name)).toBeUndefined();
            expect(yield* read(claude, name)).toBe(yield* read(library, name));
          }
          expect(yield* link(claude, "mine")).toBe(path.join(elsewhere, "mine"));
          expect((yield* fs.readDirectory(claude)).sort()).toEqual(["codex-only", "hello", "mine"]);
          // Codex reads the library itself, so it gets no second copy.
          expect(yield* fs.readDirectory(codex)).toEqual([]);
          expect((yield* fs.readDirectory(library)).sort()).toEqual(["codex-only", "hello"]);
          expect((yield* service.status).linked).toEqual([]);
        }),
    );
  });
});
