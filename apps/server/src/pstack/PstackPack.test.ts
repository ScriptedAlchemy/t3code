import { resolvePstackSourceRoot } from "../config.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import { pstackContentHash } from "@t3tools/pstack";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PstackPack from "./PstackPack.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ProjectId, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { claudeProvider, makeFixture } from "./PstackPack.testkit.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";

it.layer(NodeServices.layer)("PstackPack", (it) => {
  it.effect("resolves the development source beside the monorepo packages", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.equal(
        yield* resolvePstackSourceRoot(),
        path.resolve(import.meta.dirname, "../../../../packages/pstack"),
      );
    }).pipe(Effect.provideService(HostProcess.Environment, {})),
  );

  it.effect("prefers an existing external pstack source over the bundled source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      assert.equal(
        yield* resolvePstackSourceRoot().pipe(
          Effect.provideService(HostProcess.Environment, {
            T3CODE_PSTACK_SOURCE_ROOT: fixture.sourceRoot,
          }),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: () => Effect.succeed(true),
          }),
        ),
        fixture.sourceRoot,
      );
    }),
  );

  it.effect("falls back to the bundled source when the external source is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bundled = path.resolve(import.meta.dirname, "../pstack");
      assert.equal(
        yield* resolvePstackSourceRoot().pipe(
          Effect.provideService(HostProcess.Environment, {
            T3CODE_PSTACK_SOURCE_ROOT: "/missing/pstack",
          }),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: (file) => Effect.succeed(file === path.join(bundled, "UPSTREAM.json")),
          }),
        ),
        bundled,
      );
    }),
  );

  it.effect("materializes a published pack without gitignore metadata and preserves bun.lock", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${fixture.sourceRoot}/upstream/.gitignore`);
      yield* Effect.gen(function* () {
        const catalog = yield* (yield* PstackPack.PstackPack).catalog;
        assert.lengthOf(catalog!, 2);
        const packDir = `${fixture.stateDir}/pstack/pack`;
        assert.isFalse(yield* fs.exists(`${packDir}/.gitignore`));
        assert.equal(
          yield* fs.readFileString(`${packDir}/skills/poteto-mode/scripts/bun.lock`),
          "lockfile\n",
        );
        assert.equal(
          yield* fs.readFileString(`${packDir}/.t3-pstack-hash`),
          pstackContentHash(fixture.sourceRoot),
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect(
    "materializing twice preserves writable helper state; changed content replaces the stable directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fixture = yield* makeFixture();
        const first = yield* Effect.gen(function* () {
          const pack = yield* PstackPack.PstackPack;
          yield* pack.catalog;
          const directory = `${fixture.stateDir}/pstack/pack`;
          yield* fs.writeFileString(`${directory}/helper-state`, "installed");
          yield* pack.catalog;
          assert.equal(yield* fs.readFileString(`${directory}/helper-state`), "installed");
          assert.equal(
            Number((yield* fs.stat(`${directory}/scripts/helper.sh`)).mode) & 0o111,
            0o111,
          );
          return directory;
        }).pipe(Effect.provide(fixture.layer));
        const second = yield* Effect.gen(function* () {
          const pack = yield* PstackPack.PstackPack;
          yield* pack.catalog;
          assert.equal(yield* fs.readFileString(`${first}/helper-state`), "installed");
          return `${fixture.stateDir}/pstack/pack`;
        }).pipe(Effect.provide(fixture.layer));
        assert.equal(first, second);
        yield* fs.writeFileString(`${fixture.sourceRoot}/t3-code.md`, "Changed adapter");
        const changed = yield* Effect.gen(function* () {
          yield* (yield* PstackPack.PstackPack).catalog;
          return `${fixture.stateDir}/pstack/pack`;
        }).pipe(Effect.provide(fixture.layer));
        assert.equal(changed, first);
        assert.equal(changed, `${fixture.stateDir}/pstack/pack`);
        assert.equal(
          yield* fs.readFileString(`${changed}/docs/harness/t3-code.md`),
          "Changed adapter",
        );
      }),
  );
  it.effect("materializes archive-backed bytes with manifest executable flags", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.chmod(`${fixture.sourceRoot}/upstream/scripts/helper.sh`, 0o644);
      yield* Effect.gen(function* () {
        const catalog = yield* (yield* PstackPack.PstackPack).catalog;
        assert.lengthOf(catalog!, 2);
        const helper = `${fixture.stateDir}/pstack/pack/scripts/helper.sh`;
        assert.equal(Number((yield* fs.stat(helper)).mode) & 0o111, 0o111);
        assert.equal(yield* fs.readFileString(helper), "#!/bin/sh\nexit 0\n");
      }).pipe(
        Effect.provide(fixture.layer),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.FileSystem.of({
            ...fs,
            copyFile: () => Effect.die("Archive sources require read/write"),
          }),
        ),
      );
    }),
  );
  it.effect("reuses the source hash after the first successful read", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.gen(function* () {
        const pack = yield* PstackPack.PstackPack;
        const first = yield* pack.catalog;
        yield* fs.remove(`${fixture.sourceRoot}/t3-code.md`);
        assert.deepEqual(yield* pack.catalog, first);
        assert.lengthOf((yield* pack.catalog)!, 2);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
  it.effect("concurrent catalog reads materialize once", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const fs = yield* FileSystem.FileSystem;
      const copying = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const readersStarted = yield* Deferred.make<void>();
      let copies = 0;
      let readers = 0;
      yield* Effect.gen(function* () {
        const pack = yield* PstackPack.PstackPack;
        const first = yield* pack.catalog.pipe(Effect.forkChild);
        yield* Deferred.await(copying);
        const rest = yield* Effect.forEach(
          Array.from({ length: 7 }),
          () =>
            Effect.gen(function* () {
              readers += 1;
              if (readers === 7) yield* Deferred.succeed(readersStarted, undefined);
              return yield* pack.catalog;
            }),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* Deferred.await(readersStarted);
        yield* Deferred.succeed(release, undefined);
        const catalog = yield* Fiber.join(first);
        for (const result of yield* Fiber.join(rest)) assert.deepEqual(result, catalog);
        assert.lengthOf(catalog!, 2);
        assert.equal(copies, 1);
      }).pipe(
        Effect.provide(fixture.layer),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.FileSystem.of({
            ...fs,
            makeTempDirectory: Effect.fn("PstackPackTest.blockCopy")(function* (options) {
              copies += 1;
              yield* Deferred.succeed(copying, undefined);
              yield* Deferred.await(release);
              return yield* fs.makeTempDirectory(options);
            }),
          }),
        ),
      );
    }),
  );
  it.effect.each(["published", "verified"] as const)(
    "serves a foreign valid pack after its own stamp was %s without replacing helper state",
    (mode) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const fs = yield* FileSystem.FileSystem;
        const packDir = `${fixture.stateDir}/pstack/pack`;
        if (mode === "verified") {
          yield* Effect.gen(function* () {
            yield* (yield* PstackPack.PstackPack).catalog;
          }).pipe(Effect.provide(Layer.fresh(fixture.layer)));
        }
        yield* Effect.gen(function* () {
          const pack = yield* PstackPack.PstackPack;
          yield* pack.catalog;
          yield* fs.writeFileString(`${packDir}/.t3-pstack-hash`, "f".repeat(16));
          yield* fs.writeFileString(
            `${packDir}/skills/architect/SKILL.md`,
            "---\ndescription: Foreign version.\n---\n",
          );
          yield* fs.writeFileString(`${packDir}/helper-state`, "installed");
          for (const catalog of [yield* pack.catalog, yield* pack.catalog]) {
            assert.equal(catalog?.[0]?.description, "Foreign version.");
          }
          assert.equal(yield* fs.readFileString(`${packDir}/.t3-pstack-hash`), "f".repeat(16));
          assert.equal(yield* fs.readFileString(`${packDir}/helper-state`), "installed");
        }).pipe(Effect.provide(fixture.layer));
      }),
  );
  it.effect(
    "catalog uses bundled names, absolute paths and frontmatter; disabling hides catalog and expansion",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* Effect.gen(function* () {
          const pack = yield* PstackPack.PstackPack;
          const settings = yield* ServerSettings.ServerSettingsService;
          yield* pack.catalog;
          const directory = `${fixture.stateDir}/pstack/pack`;
          assert.deepEqual(yield* pack.catalog, [
            {
              name: "pstack:architect",
              description: "Design: a system.",
              path: `${directory}/skills/architect/SKILL.md`,
              scope: "t3",
              enabled: true,
              userInvocationOnly: true,
            },
            {
              name: "pstack:setup-pstack",
              description: "Configure roles.",
              path: `${directory}/skills/setup-pstack/SKILL.md`,
              scope: "t3",
              enabled: true,
            },
          ]);
          const input = {
            projectId: ProjectId.make("pack-test"),
            text: "$pstack:architect",
            records: [],
          };
          const expansion = (yield* pack.expandComposer(input, { createdBy: "user" })).text;
          assert.include(expansion!, "- architect runners: [1] inherit [2] inherit");
          assert.include(expansion!, "Fallback: architect runners seat 1");
          assert.equal(
            (yield* pack.expandComposer(
              { ...input, text: "$pstack:unknown" },
              { createdBy: "user" },
            )).text,
            "$pstack:unknown",
          );
          yield* settings.updateSettings({ pstackEnabled: false });
          assert.equal(yield* pack.catalog, undefined);
          assert.strictEqual(yield* pack.expandComposer(input, { createdBy: "user" }), input);
        }).pipe(Effect.provide(Layer.merge(fixture.layer, fixture.settingsLayer)));
      }),
  );
  it.effect("building the disabled service never touches a missing pack", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(fixture.sourceRoot, { recursive: true });
      yield* Effect.gen(function* () {
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
          pstackEnabled: false,
        });
        yield* Effect.gen(function* () {
          const pack = yield* PstackPack.PstackPack;
          assert.equal(yield* pack.catalog, undefined);
        }).pipe(Effect.provide(fixture.layer));
      }).pipe(Effect.provide(fixture.settingsLayer));
      assert.isFalse(yield* fs.exists(`${fixture.stateDir}/pstack`));
    }),
  );
  it.effect("an enabled catalog failure is nonfatal and can recover on the next read", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const fs = yield* FileSystem.FileSystem;
      const adapter = yield* fs.readFileString(`${fixture.sourceRoot}/t3-code.md`);
      yield* fs.remove(`${fixture.sourceRoot}/t3-code.md`);
      yield* Effect.gen(function* () {
        const pack = yield* PstackPack.PstackPack;
        assert.equal(yield* pack.catalog, undefined);
        yield* fs.writeFileString(`${fixture.sourceRoot}/t3-code.md`, adapter);
        assert.lengthOf((yield* pack.catalog)!, 2);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
  it.effect("project-disabled instances fall back and other projects retain their targets", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("restricted");
      const fixture = yield* makeFixture([claudeProvider]);
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${fixture.stateDir}/pstack`, { recursive: true });
      yield* fs.writeFileString(
        `${fixture.stateDir}/pstack/models.md`,
        "architect runners: claudeAgent/claude-opus-5-5 effort=xhigh fastMode=false",
      );
      yield* Effect.gen(function* () {
        const pack = yield* PstackPack.PstackPack;
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [claudeProvider.instanceId]: { enabled: false } } },
          },
        });
        const restricted = (yield* pack.expandComposer(
          { text: "$pstack:architect", records: [], projectId },
          { createdBy: "user" },
        )).text;
        assert.include(restricted!, "Fallback: architect runners seat 1");
        const allowed = (yield* pack.expandComposer(
          { text: "$pstack:architect", records: [], projectId: ProjectId.make("allowed") },
          { createdBy: "user" },
        )).text;
        assert.notInclude(allowed!, "Fallback:");
      }).pipe(Effect.provide(Layer.merge(fixture.layer, fixture.settingsLayer)));
    }),
  );
  it.effect("default roles skip cooling instances and choose a ready instance", () =>
    Effect.gen(function* () {
      const ready = {
        ...claudeProvider,
        instanceId: ProviderInstanceId.make("claudeAgent_ready"),
      };
      const fixture = yield* makeFixture(
        [{ ...claudeProvider, limitedUntil: "2099-01-01T00:00:00Z" }, ready],
        ServerSettings.layerTest({
          pstackEnabled: true,
          providerInstances: {
            [ready.instanceId]: { driver: ready.driver, enabled: true, config: {} },
          },
        }),
      );
      const expansion = yield* Effect.gen(function* () {
        return yield* (yield* PstackPack.PstackPack).expandComposer(
          { text: "$pstack:architect", records: [], projectId: ProjectId.make("pack-test") },
          { createdBy: "user" },
        );
      }).pipe(Effect.provide(fixture.layer));
      assert.include(
        expansion.text,
        '- architect runners: [1] {"providerInstanceId":"claudeAgent_ready"',
      );
      assert.notInclude(expansion.text, "Fallback: architect runners seat 1");
    }),
  );
  it.effect("explicit cooling targets fall back to the parent", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture([
        { ...claudeProvider, limitedUntil: "2099-01-01T00:00:00Z" },
      ]);
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${fixture.stateDir}/pstack`, { recursive: true });
      yield* fs.writeFileString(
        `${fixture.stateDir}/pstack/models.md`,
        "architect runners: claudeAgent/claude-opus-5-5",
      );
      const expansion = yield* Effect.gen(function* () {
        return yield* (yield* PstackPack.PstackPack).expandComposer(
          { text: "$pstack:architect", records: [], projectId: ProjectId.make("pack-test") },
          { createdBy: "user" },
        );
      }).pipe(Effect.provide(fixture.layer));
      assert.include(expansion.text, "- architect runners: [1] inherit");
      assert.include(expansion.text, "Provider is rate limited. Retry after its cooldown expires.");
    }),
  );
  it.effect.each(["all cooling", "healthy member disabled", "healthy member available"] as const)(
    "pool roles use project-aware delegation availability: %s",
    (scenario) =>
      Effect.gen(function* () {
        const projectId = ProjectId.make("pack-test");
        const poolId = ProviderInstanceId.make("pool_claudeAgent");
        const workId = ProviderInstanceId.make("claudeAgent_work");
        const members: ServerProvider[] = [claudeProvider.instanceId, workId].map(
          (instanceId, index) => ({
            ...claudeProvider,
            instanceId,
            pool: { role: "member", poolInstanceId: poolId },
            ...(index === 0 || scenario === "all cooling"
              ? { limitedUntil: "2099-01-01T00:00:00Z" }
              : {}),
          }),
        );
        const fixture = yield* makeFixture(
          [
            ...members,
            {
              ...claudeProvider,
              instanceId: poolId,
              pool: {
                role: "pool",
                memberInstanceIds: members.map((member) => member.instanceId),
                droppedModels: [],
              },
            },
          ],
          ServerSettings.layerTest({
            pstackEnabled: true,
            providerInstances: {
              [workId]: { driver: claudeProvider.driver, enabled: true, config: {} },
            },
            providerPools: {
              [claudeProvider.driver]: {
                enabled: true,
                memberInstanceIds: members.map((member) => member.instanceId),
              },
            },
            projectSettingsOverrides: {
              [projectId]: {
                providerInstances: {
                  [workId]: { enabled: scenario !== "healthy member disabled" },
                },
              },
            },
          }),
        );
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${fixture.stateDir}/pstack`, { recursive: true });
        yield* fs.writeFileString(
          `${fixture.stateDir}/pstack/models.md`,
          "architect runners: pool_claudeAgent/claude-opus-5-5",
        );
        const expansion = yield* Effect.gen(function* () {
          return yield* (yield* PstackPack.PstackPack).expandComposer(
            { text: "$pstack:architect", records: [], projectId },
            { createdBy: "user" },
          );
        }).pipe(Effect.provide(fixture.layer));
        if (scenario === "healthy member available") {
          assert.include(
            expansion.text,
            '- architect runners: [1] {"providerInstanceId":"pool_claudeAgent"',
          );
          assert.notInclude(expansion.text, "Fallback:");
        } else {
          assert.include(expansion.text, "- architect runners: [1] inherit");
          assert.include(expansion.text, "Every available pool member is rate limited.");
        }
      }),
  );
  it.effect("concurrent materializers tolerate a losing rename and keep the stable pack", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const fs = yield* FileSystem.FileSystem;
      const secondReady = yield* Deferred.make<void>();
      const firstPublished = yield* Deferred.make<void>();
      const packDir = `${fixture.stateDir}/pstack/pack`;
      let publishers = 0;
      const racingFs = FileSystem.FileSystem.of({
        ...fs,
        rename: Effect.fn("PstackPackTest.racingRename")(function* (from, to) {
          if (from.includes(".pack-tmp-") && to === packDir) {
            publishers += 1;
            if (publishers === 1) {
              yield* Deferred.await(secondReady);
              yield* fs.rename(from, to);
              yield* Deferred.succeed(firstPublished, undefined);
              return;
            }
            yield* Deferred.succeed(secondReady, undefined);
            yield* Deferred.await(firstPublished);
          }
          yield* fs.rename(from, to);
        }),
      });
      const read = Effect.gen(function* () {
        return yield* (yield* PstackPack.PstackPack).catalog;
      });
      const results = yield* Effect.all(
        [
          read.pipe(Effect.provide(Layer.fresh(fixture.layer))),
          read.pipe(Effect.provide(Layer.fresh(fixture.layer))),
        ],
        { concurrency: 2 },
      ).pipe(Effect.provideService(FileSystem.FileSystem, racingFs));
      assert.equal(publishers, 2);
      assert.deepEqual(results[0], results[1]);
      assert.lengthOf(results[0]!, 2);
      assert.equal(
        yield* fs.readFileString(`${packDir}/.t3-pstack-hash`),
        pstackContentHash(fixture.sourceRoot),
      );
      assert.deepEqual(yield* fs.readDirectory(`${fixture.stateDir}/pstack`), ["pack"]);
    }),
  );
  it.effect("cleans crash leftovers while preserving live materializers and legacy paths", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const fs = yield* FileSystem.FileSystem;
      const directory = `${fixture.stateDir}/pstack`;
      const live = `.pack-tmp-${process.pid}-active`;
      const keep = [live, "pack-legacy-hash", ".pack-tmp-unknown"];
      for (const name of [...keep, ".pack-tmp-0-crashed", ".pack-trash-0-crashed"])
        yield* fs.makeDirectory(`${directory}/${name}`, { recursive: true });
      yield* Effect.gen(function* () {
        assert.lengthOf((yield* (yield* PstackPack.PstackPack).catalog)!, 2);
      }).pipe(Effect.provide(fixture.layer));
      assert.deepEqual((yield* fs.readDirectory(directory)).sort(), [...keep, "pack"].sort());
    }),
  );
  it.effect("pruning failure does not hide a usable catalog", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const fs = yield* FileSystem.FileSystem;
      const directory = `${fixture.stateDir}/pstack`;
      yield* Effect.gen(function* () {
        assert.lengthOf((yield* (yield* PstackPack.PstackPack).catalog)!, 2);
      }).pipe(
        Effect.provide(fixture.layer),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.FileSystem.of({
            ...fs,
            readDirectory: (target) =>
              target === directory
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "readDirectory",
                      pathOrDescriptor: target,
                    }),
                  )
                : fs.readDirectory(target),
          }),
        ),
      );
    }),
  );
  it.effect.each(["retire", "publish"] as const)(
    "failed replacement restores and serves the previous pack, then retries (%s)",
    (failure) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const fs = yield* FileSystem.FileSystem;
        const read = Effect.gen(function* () {
          return yield* (yield* PstackPack.PstackPack).catalog;
        });
        assert.lengthOf((yield* read.pipe(Effect.provide(fixture.layer)))!, 2);
        const packDir = `${fixture.stateDir}/pstack/pack`;
        const oldStamp = yield* fs.readFileString(`${packDir}/.t3-pstack-hash`);
        yield* fs.writeFileString(`${fixture.sourceRoot}/t3-code.md`, "Next version");
        let blocked = true;
        const result = yield* Effect.gen(function* () {
          const pack = yield* PstackPack.PstackPack;
          const stale = yield* pack.catalog;
          assert.lengthOf(stale!, 2);
          assert.equal(yield* fs.readFileString(`${packDir}/.t3-pstack-hash`), oldStamp);
          assert.equal(
            yield* fs.readFileString(`${packDir}/docs/harness/t3-code.md`),
            "# T3 harness",
          );
          blocked = false;
          const fresh = yield* pack.catalog;
          assert.lengthOf(fresh!, 2);
          return fresh;
        }).pipe(
          Effect.provide(Layer.fresh(fixture.layer)),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.FileSystem.of({
              ...fs,
              rename: (from, to) =>
                blocked &&
                (failure === "retire"
                  ? from === packDir
                  : from.includes(".pack-tmp-") && to === packDir)
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "rename",
                        pathOrDescriptor: to,
                      }),
                    )
                  : fs.rename(from, to),
            }),
          ),
        );
        assert.lengthOf(result!, 2);
        assert.equal(
          yield* fs.readFileString(`${packDir}/.t3-pstack-hash`),
          pstackContentHash(fixture.sourceRoot),
        );
        assert.equal(
          yield* fs.readFileString(`${packDir}/docs/harness/t3-code.md`),
          "Next version",
        );
        assert.deepEqual(yield* fs.readDirectory(`${fixture.stateDir}/pstack`), ["pack"]);
      }),
  );
  it.effect("adapter Harnesses rows cover every built-in driver kind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const adapter = path.resolve(
        import.meta.dirname,
        "../../../..",
        "packages/pstack/t3-code.md",
      );
      const text = yield* fs.readFileString(adapter);
      const table = text.split(/^## Harnesses\s*$/m)[1]?.split(/^## /m)[0] ?? "";
      const kinds = [...table.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((match) => match[1]).sort();
      assert.deepEqual(kinds, BUILT_IN_DRIVERS.map((driver) => driver.driverKind).sort());
    }),
  );
});
