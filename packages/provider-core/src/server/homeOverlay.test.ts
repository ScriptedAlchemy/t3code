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
