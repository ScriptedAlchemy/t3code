import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { materializeHomeOverlay, type OverlayPolicy } from "./homeOverlay.ts";

const allowListPolicy: OverlayPolicy = {
  shared: () => [
    { name: "settings.json", adopt: { _tag: "Conflict" } },
    { name: "plugins", adopt: { _tag: "Conflict" }, ensureDirectory: true },
    { name: "credentials.json", adopt: { _tag: "Conflict" } },
  ],
  mustBeReal: ["credentials.json"],
  healIfLinked: [],
  retired: ["settings.json", "plugins"],
};

const makeHomes = Effect.fn("homeOverlay.test.makeHomes")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-home-overlay-" });
  return { sharedRoot: path.join(root, "shared"), accountDir: path.join(root, "account") };
});

const linkTarget = Effect.fn("homeOverlay.test.linkTarget")(function* (linkPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readLink(linkPath).pipe(Effect.orElseSucceed(() => undefined));
});

it.layer(NodeServices.layer)("materializeHomeOverlay", (it) => {
  describe("active overlay", () => {
    it.effect.skipIf(!symlinksSupported)(
      "links only the policy's entries and never its private names",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedRoot, accountDir } = yield* makeHomes();
          yield* fileSystem.makeDirectory(path.join(sharedRoot, "projects"), { recursive: true });

          yield* materializeHomeOverlay({
            sharedRoot,
            accountDir,
            policy: allowListPolicy,
            active: true,
          });

          expect(yield* linkTarget(path.join(accountDir, "settings.json"))).toBe(
            path.join(sharedRoot, "settings.json"),
          );
          expect(yield* fileSystem.exists(path.join(sharedRoot, "settings.json"))).toBe(false);
          expect(yield* linkTarget(path.join(accountDir, "plugins"))).toBe(
            path.join(sharedRoot, "plugins"),
          );
          expect((yield* fileSystem.stat(path.join(sharedRoot, "plugins"))).type).toBe("Directory");
          expect(yield* fileSystem.exists(path.join(accountDir, "projects"))).toBe(false);
          expect(yield* linkTarget(path.join(accountDir, "credentials.json"))).toBeUndefined();
        }),
    );

    it.effect.skipIf(!symlinksSupported)("rejects a linked private entry before linking", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { sharedRoot, accountDir } = yield* makeHomes();
        yield* fileSystem.makeDirectory(accountDir, { recursive: true });
        yield* fileSystem.symlink(
          path.join(sharedRoot, "credentials.json"),
          path.join(accountDir, "credentials.json"),
        );

        const error = yield* materializeHomeOverlay({
          sharedRoot,
          accountDir,
          policy: allowListPolicy,
          active: true,
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "HomeOverlayPrivateEntrySymlinkError",
          entryName: "credentials.json",
        });
        expect(yield* fileSystem.exists(path.join(accountDir, "plugins"))).toBe(false);
      }),
    );

    it.effect.skipIf(!symlinksSupported)("changes nothing when run again", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { sharedRoot, accountDir } = yield* makeHomes();
        const overlay = { sharedRoot, accountDir, policy: allowListPolicy, active: true };
        yield* materializeHomeOverlay(overlay);

        const mutations: Array<string> = [];
        const recordingFileSystem: FileSystem.FileSystem = {
          ...fileSystem,
          symlink: (target, link) => {
            mutations.push(`symlink ${link}`);
            return fileSystem.symlink(target, link);
          },
          remove: (target, options) => {
            mutations.push(`remove ${target}`);
            return fileSystem.remove(target, options);
          },
        };
        yield* materializeHomeOverlay(overlay).pipe(
          Effect.provideService(FileSystem.FileSystem, recordingFileSystem),
        );

        expect(mutations).toEqual([]);
      }),
    );

    it.effect.skipIf(!symlinksSupported)("accepts a link a concurrent setup created first", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { sharedRoot, accountDir } = yield* makeHomes();
        const racingFileSystem: FileSystem.FileSystem = {
          ...fileSystem,
          symlink: (target, link) =>
            fileSystem.symlink(target, link).pipe(Effect.andThen(fileSystem.symlink(target, link))),
        };

        yield* materializeHomeOverlay({
          sharedRoot,
          accountDir,
          policy: allowListPolicy,
          active: true,
        }).pipe(Effect.provideService(FileSystem.FileSystem, racingFileSystem));

        expect(yield* linkTarget(path.join(accountDir, "plugins"))).toBe(
          path.join(sharedRoot, "plugins"),
        );
      }),
    );
  });

  describe("directory adoption", () => {
    const policy: OverlayPolicy = {
      ...allowListPolicy,
      shared: () => [
        { name: "settings.json", adopt: { _tag: "Conflict" } },
        {
          name: "plugins",
          ensureDirectory: true,
          adopt: {
            _tag: "FoldDirectory",
            children: (name) =>
              name === "synced"
                ? {
                    _tag: "FoldDirectory",
                    children: (child) => ({
                      _tag: "Move",
                      kind: child.startsWith(".bucket-") ? "file" : "directory",
                    }),
                  }
                : name === "plugin-directory-cache-v2.json"
                  ? { _tag: "Drop" }
                  : { _tag: "Conflict" },
          },
        },
      ],
    };

    it.effect.skipIf(!symlinksSupported)(
      "folds buckets and markers and converges after a published file",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homes = yield* makeHomes();
          const local = path.join(homes.accountDir, "plugins");
          const shared = path.join(homes.sharedRoot, "plugins");
          yield* fs.makeDirectory(path.join(local, "synced", "org_account"), { recursive: true });
          yield* fs.makeDirectory(path.join(shared, "synced"), { recursive: true });
          yield* fs.writeFileString(path.join(local, "synced", "org_account", "skill.md"), "skill");
          yield* fs.writeFileString(path.join(local, "synced", ".bucket-org_account"), "marker");
          yield* fs.link(
            path.join(local, "synced", ".bucket-org_account"),
            path.join(shared, "synced", ".bucket-org_account"),
          );
          yield* fs.writeFileString(path.join(local, "plugin-directory-cache-v2.json"), "cache");
          const overlay = { ...homes, policy, active: true };
          yield* materializeHomeOverlay(overlay);
          yield* materializeHomeOverlay(overlay);
          expect(yield* fs.readLink(local)).toBe(shared);
          expect(
            yield* fs.readFileString(path.join(shared, "synced", "org_account", "skill.md")),
          ).toBe("skill");
          expect(yield* fs.readFileString(path.join(shared, "synced", ".bucket-org_account"))).toBe(
            "marker",
          );
          expect(yield* fs.exists(path.join(shared, "plugin-directory-cache-v2.json"))).toBe(false);
        }),
    );

    for (const peer of ["file", "symlink"]) {
      it.effect.skipIf(!symlinksSupported)(
        `does not overwrite a marker ${peer} published by a peer`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const homes = yield* makeHomes();
            const source = path.join(homes.accountDir, "plugins", "synced", ".bucket-org_account");
            const target = path.join(homes.sharedRoot, "plugins", "synced", ".bucket-org_account");
            yield* fs.makeDirectory(path.dirname(source), { recursive: true });
            yield* fs.writeFileString(source, "account");
            const racing: FileSystem.FileSystem = {
              ...fs,
              link: (from, to) =>
                (peer === "file" ? fs.writeFileString(to, "peer") : fs.symlink(from, to)).pipe(
                  Effect.andThen(fs.link(from, to)),
                ),
            };
            const error = yield* materializeHomeOverlay({ ...homes, policy, active: true }).pipe(
              Effect.provideService(FileSystem.FileSystem, racing),
              Effect.flip,
            );
            expect(error).toMatchObject({
              _tag: "HomeOverlayEntryConflictError",
              linkPath: source,
            });
            expect(yield* fs.readFileString(source)).toBe("account");
            if (peer === "file") expect(yield* fs.readFileString(target)).toBe("peer");
            else expect(yield* fs.readLink(target)).toBe(source);
          }),
      );
    }

    for (const entry of [
      "settings.json",
      "plugins/installed_plugins.json",
      "plugins/synced/.bucket-org_account",
      "plugins/synced/org_account",
    ]) {
      it.effect.skipIf(!symlinksSupported)(
        `preserves conflicting ${entry} without overwriting shared content`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const homes = yield* makeHomes();
            const source = path.join(homes.accountDir, entry);
            const target = path.join(homes.sharedRoot, entry);
            yield* fs.makeDirectory(path.dirname(source), { recursive: true });
            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            const directory = entry.endsWith("/org_account");
            if (directory) {
              yield* fs.makeDirectory(source);
              yield* fs.makeDirectory(target);
            }
            const sourceFile = directory ? path.join(source, "skill.md") : source;
            const targetFile = directory ? path.join(target, "skill.md") : target;
            yield* fs.writeFileString(sourceFile, "account");
            yield* fs.writeFileString(targetFile, "shared");
            const error = yield* materializeHomeOverlay({ ...homes, policy, active: true }).pipe(
              Effect.flip,
            );
            expect(error).toMatchObject({
              _tag: "HomeOverlayEntryConflictError",
              linkPath: source,
            });
            expect(yield* fs.readFileString(sourceFile)).toBe("account");
            expect(yield* fs.readFileString(targetFile)).toBe("shared");
          }),
      );
    }
    it.effect.skipIf(!symlinksSupported)(
      "moves an entry once, keeps one of two equal copies, and refuses different ones",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homes = yield* makeHomes();
          const write = (root: string, name: string, contents: string) =>
            fs
              .makeDirectory(path.join(root, name), { recursive: true })
              .pipe(
                Effect.andThen(fs.writeFileString(path.join(root, name, "SKILL.md"), contents)),
              );
          yield* write(homes.accountDir, "only-here", "one");
          yield* write(homes.accountDir, "same", "equal");
          yield* write(homes.sharedRoot, "same", "equal");
          yield* fs.writeFileString(path.join(homes.sharedRoot, "same", ".DS_Store"), "finder");
          const move = { _tag: "Move", kind: "directory" } as const;
          const overlay = (names: ReadonlyArray<string>) => ({
            ...homes,
            active: true,
            policy: {
              shared: () => names.map((name) => ({ name, adopt: move })),
              mustBeReal: [],
              healIfLinked: [],
              retired: [],
            },
          });

          yield* materializeHomeOverlay(overlay(["only-here", "same"]));
          yield* materializeHomeOverlay(overlay(["only-here", "same"]));

          for (const name of ["only-here", "same"]) {
            expect(yield* linkTarget(path.join(homes.accountDir, name))).toBe(
              path.join(homes.sharedRoot, name),
            );
          }
          expect(
            yield* fs.readFileString(path.join(homes.sharedRoot, "only-here", "SKILL.md")),
          ).toBe("one");
          expect(yield* fs.readDirectory(homes.accountDir)).toHaveLength(2);

          yield* write(homes.accountDir, "differs", "account");
          yield* write(homes.sharedRoot, "differs", "shared");
          const error = yield* materializeHomeOverlay(overlay(["differs"])).pipe(Effect.flip);
          expect(error).toMatchObject({ _tag: "HomeOverlayEntryConflictError" });
          expect(yield* fs.readFileString(path.join(homes.accountDir, "differs", "SKILL.md"))).toBe(
            "account",
          );
          expect(yield* fs.readFileString(path.join(homes.sharedRoot, "differs", "SKILL.md"))).toBe(
            "shared",
          );

          // Equal bytes where only one copy runs; equal link text that lands on different files.
          yield* write(homes.accountDir, "mode", "same");
          yield* write(homes.sharedRoot, "mode", "same");
          yield* fs.chmod(path.join(homes.accountDir, "mode", "SKILL.md"), 0o755);
          for (const root of [homes.accountDir, homes.sharedRoot]) {
            yield* write(root, "escapes", "same");
            yield* fs.writeFileString(path.join(root, "outside.md"), root);
            yield* fs.symlink("../outside.md", path.join(root, "escapes", "linked.md"));
          }
          for (const name of ["mode", "escapes"]) {
            const differs = yield* materializeHomeOverlay(overlay([name])).pipe(Effect.flip);
            expect(differs).toMatchObject({ _tag: "HomeOverlayEntryConflictError" });
            expect(yield* linkTarget(path.join(homes.accountDir, name))).toBeUndefined();
          }

          // The discard path is the user's unless it holds what an earlier discard left.
          yield* write(homes.accountDir, "kept", "equal");
          yield* write(homes.sharedRoot, "kept", "equal");
          yield* write(homes.accountDir, ".kept.t3-discard", "mine");
          const occupied = yield* materializeHomeOverlay(overlay(["kept"])).pipe(Effect.flip);
          expect(occupied).toMatchObject({ _tag: "HomeOverlayEntryConflictError" });
          expect(
            yield* fs.readFileString(path.join(homes.accountDir, ".kept.t3-discard", "SKILL.md")),
          ).toBe("mine");
          expect(yield* linkTarget(path.join(homes.accountDir, "kept"))).toBeUndefined();
          yield* write(homes.accountDir, ".kept.t3-discard", "equal");
          yield* materializeHomeOverlay(overlay(["kept"]));
          expect(yield* linkTarget(path.join(homes.accountDir, "kept"))).toBe(
            path.join(homes.sharedRoot, "kept"),
          );
          expect(yield* fs.exists(path.join(homes.accountDir, ".kept.t3-discard"))).toBe(false);
        }),
    );
  });

  describe("inactive overlay", () => {
    it.effect.skipIf(!symlinksSupported)("retires only links into the shared root", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { sharedRoot, accountDir } = yield* makeHomes();
        const elsewhere = path.join(path.dirname(sharedRoot), "elsewhere");
        yield* materializeHomeOverlay({
          sharedRoot,
          accountDir,
          policy: allowListPolicy,
          active: true,
        });
        yield* fileSystem.remove(path.join(accountDir, "settings.json"));
        yield* fileSystem.symlink(
          path.join(elsewhere, "settings.json"),
          path.join(accountDir, "settings.json"),
        );
        yield* fileSystem.symlink(path.join(sharedRoot, "agents"), path.join(accountDir, "agents"));

        yield* materializeHomeOverlay({
          sharedRoot,
          accountDir,
          policy: allowListPolicy,
          active: false,
        });

        expect(yield* fileSystem.exists(path.join(accountDir, "plugins"))).toBe(false);
        expect(yield* fileSystem.exists(path.join(sharedRoot, "plugins"))).toBe(true);
        expect(yield* linkTarget(path.join(accountDir, "settings.json"))).toBe(
          path.join(elsewhere, "settings.json"),
        );
        expect(yield* linkTarget(path.join(accountDir, "agents"))).toBe(
          path.join(sharedRoot, "agents"),
        );
      }),
    );
  });
});
