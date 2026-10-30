// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem has no lstat or realpath.
import * as NodeFSP from "node:fs/promises";
import {
  CodexSettings,
  ProviderDriverKind,
  SkillsLibraryError,
  type SkillsLibraryStatus,
} from "@t3tools/contracts";
import { materializeHomeOverlay, sameContent } from "@t3tools/provider-core/server/homeOverlay";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parseSkillFrontmatter } from "@t3tools/shared/skillFrontmatter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

const CODEX_DEFAULTS = Schema.decodeSync(CodexSettings)({});
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");

interface HarnessSkillRoot {
  readonly driver: ProviderDriverKind;
  readonly home: (
    environment: NodeJS.ProcessEnv,
    home: string,
  ) => Effect.Effect<string, never, Path.Path>;
  /** Names the harness itself writes, never moved or linked. */
  readonly private: ReadonlyArray<string>;
  /** Reads ~/.agents/skills natively, so detaching only removes its links. */
  readonly readsLibrary: boolean;
}

/** Each harness's user skill folder. A root is used only while its harness home exists. */
const HARNESS_SKILL_ROOTS: ReadonlyArray<HarnessSkillRoot> = [
  {
    driver: CLAUDE,
    home: (environment) => resolveClaudeHomePath({ homePath: "" }, environment),
    // Claude writes account-synced skills here.
    private: ["synced"],
    readsLibrary: false,
  },
  {
    driver: CODEX,
    home: (environment) =>
      resolveCodexHomeLayout(CODEX_DEFAULTS, environment).pipe(
        Effect.map((layout) => layout.sharedHomePath),
      ),
    // Codex installs its bundled skills here.
    private: [".system"],
    readsLibrary: true,
  },
  {
    driver: ProviderDriverKind.make("antigravity"),
    home: (_environment, home) =>
      Path.Path.pipe(Effect.map((path) => path.join(home, ".gemini", "config"))),
    private: [],
    readsLibrary: false,
  },
];

type EntryKind = "skill" | "libraryLink" | "otherLink" | "other";

interface RootScan {
  readonly root: HarnessSkillRoot;
  readonly directory: string;
  readonly skills: ReadonlyArray<string>;
  readonly linked: ReadonlyArray<string>;
  readonly otherLinks: ReadonlyArray<string>;
}

interface LibraryScan {
  readonly libraryPath: string;
  readonly roots: ReadonlyArray<RootScan>;
  readonly conflicts: SkillsLibraryStatus["conflicts"];
  readonly copies: ReadonlyMap<string, ReadonlyArray<string>>;
}

const RESTORE_SUFFIX = ".t3-restore";

export class SkillsLibrary extends Context.Service<
  SkillsLibrary,
  {
    readonly status: Effect.Effect<SkillsLibraryStatus, SkillsLibraryError>;
    /** Moves real skill folders into the library and links every library skill into each root. */
    readonly apply: Effect.Effect<void, SkillsLibraryError>;
    /** Turns each link into the library back into a real folder. */
    readonly detach: Effect.Effect<void, SkillsLibraryError>;
    /** Applies or detaches to match `skillsLibraryEnabled`, then reports status. */
    readonly refresh: Effect.Effect<SkillsLibraryStatus, SkillsLibraryError>;
  }
>()("t3/skills/SkillsLibrary") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const lock = yield* Semaphore.make(1);

  const fail = (operation: SkillsLibraryError["operation"], filePath: string) => (cause: unknown) =>
    new SkillsLibraryError({ operation, path: filePath, cause });

  const io = <A>(
    operation: SkillsLibraryError["operation"],
    filePath: string,
    run: () => Promise<A>,
  ) => Effect.tryPromise({ try: run, catch: fail(operation, filePath) });

  const exists = (filePath: string) =>
    io("scan", filePath, () =>
      NodeFSP.stat(filePath).then(
        () => true,
        (cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return false;
          throw cause;
        },
      ),
    );

  const realPath = (filePath: string) =>
    io("scan", filePath, () =>
      NodeFSP.realpath(filePath).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return filePath;
        throw cause;
      }),
    );

  const listNames = (directory: string, privateNames: ReadonlyArray<string>) =>
    io("scan", directory, () =>
      NodeFSP.readdir(directory).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return [];
        throw cause;
      }),
    ).pipe(
      Effect.map((names) =>
        names.filter((name) => !name.startsWith(".") && !privateNames.includes(name)).sort(),
      ),
    );

  const entryKind = Effect.fn("SkillsLibrary.entryKind")(function* (
    directory: string,
    name: string,
    libraryPath: string,
  ): Effect.fn.Return<EntryKind, SkillsLibraryError> {
    const entryPath = path.join(directory, name);
    const info = yield* io("scan", entryPath, () => NodeFSP.lstat(entryPath));
    if (info.isSymbolicLink()) {
      const target = yield* io("scan", entryPath, () => NodeFSP.readlink(entryPath));
      return path.dirname(path.resolve(directory, target)) === libraryPath
        ? "libraryLink"
        : "otherLink";
    }
    if (!info.isDirectory()) return "other";
    return (yield* exists(path.join(entryPath, "SKILL.md"))) ? "skill" : "other";
  });

  const resolveRoots = Effect.fn("SkillsLibrary.resolveRoots")(function* () {
    const libraryPath = path.join(home, ".agents", "skills");
    const libraryReal = yield* realPath(libraryPath);
    const roots: Array<{ readonly root: HarnessSkillRoot; readonly directory: string }> = [];
    for (const root of HARNESS_SKILL_ROOTS) {
      const harnessHome = yield* root.home(environment, home);
      if (!(yield* exists(harnessHome))) continue;
      const directory = path.join(harnessHome, "skills");
      // Treating the library itself as a root would delete its copies as duplicates of themselves.
      if ((yield* realPath(directory)) === libraryReal) continue;
      roots.push({ root, directory });
    }
    return { libraryPath, roots };
  });

  const scan = Effect.fn("SkillsLibrary.scan")(function* () {
    const { libraryPath, roots } = yield* resolveRoots();
    const librarySkills = yield* Effect.filter(yield* listNames(libraryPath, []), (name) =>
      exists(path.join(libraryPath, name, "SKILL.md")),
    );
    const rootScans: Array<RootScan> = [];
    for (const { root, directory } of roots) {
      const kinds = yield* Effect.forEach(yield* listNames(directory, root.private), (name) =>
        entryKind(directory, name, libraryPath).pipe(Effect.map((kind) => ({ name, kind }))),
      );
      const named = (kind: EntryKind) =>
        kinds.filter((entry) => entry.kind === kind).map((entry) => entry.name);
      rootScans.push({
        root,
        directory,
        skills: named("skill"),
        linked: named("libraryLink"),
        otherLinks: named("otherLink"),
      });
    }

    const copies = new Map<string, Array<string>>();
    for (const name of librarySkills) copies.set(name, [path.join(libraryPath, name)]);
    for (const rootScan of rootScans) {
      for (const name of rootScan.skills) {
        copies.set(name, [...(copies.get(name) ?? []), path.join(rootScan.directory, name)]);
      }
    }

    const conflicts: Array<SkillsLibraryStatus["conflicts"][number]> = [];
    for (const [name, [first, ...others]] of copies) {
      if (first === undefined) continue;
      for (const other of others) {
        if (!(yield* io("scan", other, () => sameContent(path, first, other)))) {
          conflicts.push({ name, paths: [first, other] });
          break;
        }
      }
    }
    for (const rootScan of rootScans) {
      for (const name of rootScan.otherLinks) {
        const first = copies.get(name)?.[0];
        if (first === undefined || conflicts.some((conflict) => conflict.name === name)) continue;
        conflicts.push({ name, paths: [path.join(rootScan.directory, name), first] });
      }
    }

    return {
      libraryPath,
      roots: rootScans,
      conflicts,
      copies,
    } satisfies LibraryScan;
  });

  const nameMismatches = Effect.fn("SkillsLibrary.nameMismatches")(function* (
    current: LibraryScan,
  ) {
    const mismatches: Array<SkillsLibraryStatus["nameMismatches"][number]> = [];
    for (const [name, [first]] of current.copies) {
      if (first === undefined) continue;
      const skillPath = path.join(first, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.mapError(fail("scan", skillPath)));
      const frontmatter = parseSkillFrontmatter(contents);
      if (frontmatter.kind === "parsed" && frontmatter.name && frontmatter.name !== name) {
        mismatches.push({ name, frontmatterName: frontmatter.name });
      }
    }
    return mismatches;
  });

  const status = Effect.fn("SkillsLibrary.status")(function* () {
    const current = yield* scan();
    return {
      libraryPath: current.libraryPath,
      linked: current.roots.flatMap((rootScan) =>
        rootScan.linked.map((name) => ({ driver: rootScan.root.driver, name })),
      ),
      conflicts: current.conflicts,
      nameMismatches: yield* nameMismatches(current),
    } satisfies SkillsLibraryStatus;
  });

  const apply = Effect.fn("SkillsLibrary.apply")(function* () {
    const current = yield* scan();
    const conflicted = new Set(current.conflicts.map((conflict) => conflict.name));
    const linkable = [...current.copies.keys()].filter((name) => !conflicted.has(name));
    for (const rootScan of current.roots) {
      // A skill deleted from the library leaves its links dangling; remove them with it.
      for (const name of rootScan.linked.filter((linked) => !current.copies.has(linked))) {
        const linkPath = path.join(rootScan.directory, name);
        yield* io("apply", linkPath, () => NodeFSP.unlink(linkPath));
      }
      const names = linkable.filter((name) => !rootScan.root.private.includes(name));
      yield* materializeHomeOverlay({
        sharedRoot: current.libraryPath,
        accountDir: rootScan.directory,
        active: true,
        policy: {
          shared: () =>
            names.map((name) => ({ name, adopt: { _tag: "Move", kind: "directory" } as const })),
          mustBeReal: [],
          healIfLinked: [],
          retired: [],
        },
      }).pipe(Effect.mapError(fail("apply", rootScan.directory)));
    }
  });

  const restore = Effect.fn("SkillsLibrary.restore")(function* (
    libraryPath: string,
    rootScan: RootScan,
  ) {
    const { directory } = rootScan;
    // Finish a copy a crash left between unlinking and renaming; drop one it left half-written.
    const pending = (yield* io("detach", directory, () => NodeFSP.readdir(directory))).filter(
      (name) => name.startsWith(".") && name.endsWith(RESTORE_SUFFIX),
    );
    for (const staged of pending) {
      const name = staged.slice(1, -RESTORE_SUFFIX.length);
      const stagedPath = path.join(directory, staged);
      const finalPath = path.join(directory, name);
      const present = yield* io("detach", finalPath, () =>
        NodeFSP.lstat(finalPath).then(
          () => true,
          (cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return false;
            throw cause;
          },
        ),
      );
      yield* io("detach", stagedPath, () =>
        present
          ? NodeFSP.rm(stagedPath, { recursive: true, force: true })
          : NodeFSP.rename(stagedPath, finalPath),
      );
    }
    for (const name of rootScan.linked) {
      const linkPath = path.join(directory, name);
      const target = path.join(libraryPath, name);
      if (!rootScan.root.readsLibrary && (yield* exists(target))) {
        const stagedPath = path.join(directory, `.${name}${RESTORE_SUFFIX}`);
        yield* io("detach", stagedPath, () =>
          NodeFSP.rm(stagedPath, { recursive: true, force: true }),
        );
        yield* fileSystem.copy(target, stagedPath).pipe(Effect.mapError(fail("detach", target)));
        yield* io("detach", linkPath, () => NodeFSP.unlink(linkPath));
        yield* io("detach", stagedPath, () => NodeFSP.rename(stagedPath, linkPath));
      } else {
        yield* io("detach", linkPath, () => NodeFSP.unlink(linkPath));
      }
    }
  });

  const detach = Effect.fn("SkillsLibrary.detach")(function* () {
    const current = yield* scan();
    for (const rootScan of current.roots) {
      yield* restore(current.libraryPath, rootScan);
    }
  });

  const refresh = Effect.fn("SkillsLibrary.refresh")(function* () {
    const enabled = yield* settings.getSettings.pipe(
      Effect.map((current) => current.skillsLibraryEnabled),
      Effect.mapError(fail("scan", "settings")),
    );
    yield* enabled ? apply() : detach();
    return yield* status();
  });

  const exclusive = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      lock.withPermits(1),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.HomeDirectory, home),
    );
  return SkillsLibrary.of({
    status: exclusive(status()),
    apply: exclusive(apply()),
    detach: exclusive(detach()),
    refresh: exclusive(refresh()),
  });
});

const isClaudeOrCodex = (driverKind: ProviderDriverKind) =>
  driverKind === CLAUDE || driverKind === CODEX;

export const layer = Layer.effect(
  SkillsLibrary,
  Effect.gen(function* () {
    const library = yield* make;
    const settings = yield* ServerSettings.ServerSettingsService;
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const logFailure = Effect.catch((error: SkillsLibraryError) =>
      Effect.logWarning("Skills library could not be updated", error),
    );

    const settingsChanges = yield* settings.subscribeChanges;
    const instanceChanges = yield* registry.subscribeChanges;
    let enabled = yield* settings.getSettings.pipe(
      Effect.map((current) => current.skillsLibraryEnabled),
      Effect.orElseSucceed(() => false),
    );
    const instanceIds = (
      instances: ReadonlyArray<{ instanceId: string; driverKind: ProviderDriverKind }>,
    ) =>
      new Set(
        instances
          .filter((instance) => isClaudeOrCodex(instance.driverKind))
          .map((instance) => instance.instanceId),
      );
    let known = instanceIds(yield* registry.listInstances);

    if (enabled) yield* library.apply.pipe(logFailure, Effect.forkScoped);
    yield* Stream.runForEach(settingsChanges, (next) => {
      if (next.skillsLibraryEnabled === enabled) return Effect.void;
      enabled = next.skillsLibraryEnabled;
      return (enabled ? library.apply : library.detach).pipe(logFailure);
    }).pipe(Effect.forkScoped);
    yield* Stream.fromSubscription(instanceChanges).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const current = instanceIds(yield* registry.listInstances);
          const created = [...current].some((id) => !known.has(id));
          known = current;
          if (created && enabled) yield* library.apply.pipe(logFailure);
        }),
      ),
      Effect.forkScoped,
    );
    return library;
  }),
);
