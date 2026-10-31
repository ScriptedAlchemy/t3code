// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem has no lstat.
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { discoverAntigravitySkills } from "../provider/Drivers/AntigravitySkills.ts";
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
      "keeps one copy of shared skills and links every native harness root",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, claude, codex, library, service, skill, read, link } =
            yield* setup();
          yield* skill(claude, "shared", "same");
          yield* skill(codex, "shared", "same");
          yield* skill(claude, "claude-only", "claude");
          const antigravity = path.join(home, ".gemini", "antigravity-cli", "skills");
          yield* skill(antigravity, "antigravity-only", "antigravity");
          yield* skill(path.join(claude, "synced", "org_account"), "synced-skill", "synced");
          yield* skill(path.join(codex, ".system"), "bundled", "bundled");
          // A root that already is the library must not be emptied into itself.
          yield* fs.makeDirectory(path.join(home, ".gemini", "config"), { recursive: true });
          yield* fs.makeDirectory(path.dirname(library), { recursive: true });
          yield* fs.makeDirectory(library);
          yield* fs.symlink(library, path.join(home, ".gemini", "config", "skills"));

          yield* service.apply;

          expect((yield* fs.readDirectory(library)).sort()).toEqual([
            "antigravity-only",
            "claude-only",
            "shared",
          ]);
          expect(yield* read(library, "shared")).toContain("same");
          for (const root of [claude, codex, antigravity]) {
            expect(yield* link(root, "shared")).toBe(path.join(library, "shared"));
            expect(yield* link(root, "claude-only")).toBe(path.join(library, "claude-only"));
            expect(yield* link(root, "antigravity-only")).toBe(
              path.join(library, "antigravity-only"),
            );
          }
          expect(
            (yield* discoverAntigravitySkills({
              cwd: path.join(home, "project"),
              userHome: home,
            })).map((skill) => skill.name),
          ).toEqual(["antigravity-only", "claude-only", "shared"]);
          expect(yield* read(path.join(claude, "synced", "org_account"), "synced-skill")).toContain(
            "synced",
          );
          expect(yield* read(path.join(codex, ".system"), "bundled")).toContain("bundled");
          expect(yield* fs.readDirectory(path.join(codex, ".system"))).toEqual(["bundled"]);

          const status = yield* service.status;
          expect(status.libraryPath).toBe(library);
          expect(status.conflicts).toEqual([]);
          expect(status.linked).toEqual([
            { driver: "claudeAgent", name: "antigravity-only" },
            { driver: "claudeAgent", name: "claude-only" },
            { driver: "claudeAgent", name: "shared" },
            { driver: "codex", name: "antigravity-only" },
            { driver: "codex", name: "claude-only" },
            { driver: "codex", name: "shared" },
            { driver: "antigravity", name: "antigravity-only" },
            { driver: "antigravity", name: "claude-only" },
            { driver: "antigravity", name: "shared" },
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
          const { fs, path, home, claude, codex, library, service, skill, read, link } =
            yield* setup();
          yield* skill(claude, "review", "claude version");
          yield* skill(codex, "review", "codex version");
          yield* skill(codex, "other", "other");
          // One folder on a case-insensitive disk, two on a case-sensitive one.
          yield* skill(claude, "Deploy", "same");
          yield* skill(codex, "deploy", "same");
          // Moving it would break a link that climbs out of the skill.
          yield* fs.makeDirectory(path.join(claude, "linked-out"));
          yield* fs.writeFileString(path.join(home, ".claude", "shared.md"), "shared");
          yield* fs.symlink("../../shared.md", path.join(claude, "linked-out", "SKILL.md"));
          // Codex's equal copy would be parked at a path the user already uses.
          yield* skill(claude, "dup", "same");
          yield* skill(codex, "dup", "same");
          yield* skill(codex, ".dup.t3-discard", "mine");

          yield* service.apply;

          expect(yield* read(claude, "review")).toContain("claude version");
          expect(yield* read(codex, "review")).toContain("codex version");
          expect(yield* link(claude, "review")).toBeUndefined();
          expect(yield* link(claude, "other")).toBe(path.join(library, "other"));
          for (const [root, name] of [
            [claude, "Deploy"],
            [codex, "deploy"],
            [claude, "linked-out"],
            [claude, "dup"],
            [codex, "dup"],
          ] as const) {
            expect(yield* link(root, name)).toBeUndefined();
          }
          expect(yield* read(claude, "linked-out")).toBe("shared");
          expect(yield* read(codex, ".dup.t3-discard")).toContain("mine");
          expect((yield* service.status).conflicts).toEqual([
            { name: "Deploy", paths: [path.join(claude, "Deploy"), path.join(codex, "deploy")] },
            { name: "review", paths: [path.join(claude, "review"), path.join(codex, "review")] },
            {
              name: "linked-out",
              paths: [path.join(claude, "linked-out"), path.join(claude, "linked-out", "SKILL.md")],
              reason: "outsideLink",
            },
            {
              name: "dup",
              paths: [path.join(codex, ".dup.t3-discard"), path.join(claude, "dup")],
            },
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
          yield* skill(claude, "kept", "kept");
          yield* skill(codex, "codex-only", "codex");
          const antigravityRoots = ["config", "antigravity-cli"].map((directory) =>
            path.join(home, ".gemini", directory, "skills"),
          );
          for (const root of antigravityRoots) yield* fs.makeDirectory(root, { recursive: true });
          yield* service.apply;
          const elsewhere = path.join(home, "dev", "skills");
          yield* skill(elsewhere, "mine", "mine");
          yield* fs.symlink(path.join(elsewhere, "mine"), path.join(claude, "mine"));
          // Points into the library under another name, so it is the user's link.
          yield* fs.symlink(path.join(library, "hello"), path.join(claude, "alias"));
          // A folder at the staging path that is not a copy of what it would restore.
          yield* skill(claude, ".kept.t3-restore", "mine");
          // A crash after unlinking, before the rename, leaves only the staged copy.
          yield* fs.remove(path.join(claude, "codex-only"));
          yield* fs.copy(
            path.join(library, "codex-only"),
            path.join(claude, ".codex-only.t3-restore"),
          );

          yield* service.detach;
          yield* service.detach;

          for (const name of ["hello", "codex-only"]) {
            for (const root of [claude, ...antigravityRoots]) {
              expect(yield* link(root, name)).toBeUndefined();
              expect(yield* read(root, name)).toBe(yield* read(library, name));
            }
          }
          expect(yield* link(claude, "mine")).toBe(path.join(elsewhere, "mine"));
          expect(yield* link(claude, "alias")).toBe(path.join(library, "hello"));
          expect(yield* link(claude, "kept")).toBe(path.join(library, "kept"));
          expect(yield* read(claude, ".kept.t3-restore")).toContain("mine");
          expect((yield* fs.readDirectory(claude)).sort()).toEqual([
            ".kept.t3-restore",
            "alias",
            "codex-only",
            "hello",
            "kept",
            "mine",
          ]);
          // Codex reads the library itself, so it gets no second copy.
          expect(yield* fs.readDirectory(codex)).toEqual([]);
          expect((yield* fs.readDirectory(library)).sort()).toEqual([
            "codex-only",
            "hello",
            "kept",
          ]);
          const status = yield* service.status;
          expect(status.linked).toEqual([{ driver: "claudeAgent", name: "kept" }]);
          expect(status.conflicts).toEqual([
            {
              name: "kept",
              paths: [path.join(claude, ".kept.t3-restore"), path.join(claude, "kept")],
            },
          ]);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "finishes at startup a detach a restart interrupted while the switch is off",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, claude, library, service, skill, read, link } = yield* setup();
          yield* skill(claude, "hello", "hello");
          yield* service.apply;
          yield* fs.remove(path.join(claude, "hello"));
          yield* fs.copy(path.join(library, "hello"), path.join(claude, ".hello.t3-restore"));

          yield* Layer.build(SkillsLibrary.layer).pipe(
            Effect.provide(
              Layer.mergeAll(
                ServerSettings.ServerSettingsService.layerTest(),
                Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                  listInstances: Effect.succeed([]),
                  subscribeChanges: PubSub.unbounded<void>().pipe(Effect.flatMap(PubSub.subscribe)),
                }),
              ),
            ),
            Effect.provideService(HostProcess.HomeDirectory, home),
            Effect.provideService(HostProcess.Environment, { HOME: home }),
          );

          expect(yield* link(claude, "hello")).toBeUndefined();
          expect(yield* read(claude, "hello")).toBe(yield* read(library, "hello"));
          expect(yield* fs.readDirectory(claude)).toEqual(["hello"]);
        }),
    );
  });
});
