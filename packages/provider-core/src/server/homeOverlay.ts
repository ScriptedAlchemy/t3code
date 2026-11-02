// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem has no lstat or nonrecursive directory removal.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export type OverlayFold =
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Drop" }
  | { readonly _tag: "Move"; readonly kind: "file" | "directory" }
  | { readonly _tag: "FoldDirectory"; readonly children: (name: string) => OverlayFold };

export type OverlayAdopt =
  | Extract<OverlayFold, { readonly _tag: "FoldDirectory" | "Move" }>
  | { readonly _tag: "Conflict" }
  | {
      readonly _tag: "Replace";
      readonly defer?: {
        readonly when: (childNames: ReadonlyArray<string>) => boolean;
        readonly warning: string;
      };
    };

interface OverlayEntry {
  readonly name: string;
  readonly adopt: OverlayAdopt;
  /** Created in the shared root first so the link never dangles. */
  readonly ensureDirectory?: boolean;
}

export interface OverlayPolicy {
  /** Entries to link, given the shared root's current names. Private names are never linked. */
  readonly shared: (sharedNames: ReadonlyArray<string>) => ReadonlyArray<OverlayEntry>;
  /** A symlink here is a hard error, checked before any link changes. */
  readonly mustBeReal: ReadonlyArray<string>;
  /** A symlink here is derived state from an older layout and is removed. */
  readonly healIfLinked: ReadonlyArray<string>;
  /** Links removed while the overlay is inactive, only when they point at the shared root's entry. */
  readonly retired: ReadonlyArray<string>;
}

export interface HomeOverlay {
  readonly sharedRoot: string;
  readonly accountDir: string;
  readonly policy: OverlayPolicy;
  readonly active: boolean;
}

const HomeOverlayContext = {
  sharedRoot: Schema.String,
  accountDir: Schema.String,
};

export class HomeOverlayFileSystemError extends Schema.TaggedError<HomeOverlayFileSystemError>()(
  "HomeOverlayFileSystemError",
  {
    ...HomeOverlayContext,
    operation: Schema.Literals([
      "readLink",
      "makeDirectory",
      "readDirectory",
      "remove",
      "symlink",
      "stat",
      "link",
      "rename",
    ]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.targetPath === undefined ? "" : ` to '${this.targetPath}'`;
    return `Home overlay filesystem operation '${this.operation}' failed for '${this.path}'${target}.`;
  }
}

export class HomeOverlayPathConflictError extends Schema.TaggedError<HomeOverlayPathConflictError>()(
  "HomeOverlayPathConflictError",
  HomeOverlayContext,
) {
  override get message(): string {
    return `Home overlay path '${this.accountDir}' must be different from the shared root '${this.sharedRoot}'.`;
  }
}

export class HomeOverlayEntryConflictError extends Schema.TaggedError<HomeOverlayEntryConflictError>()(
  "HomeOverlayEntryConflictError",
  {
    ...HomeOverlayContext,
    entryName: Schema.String,
    linkPath: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot link home overlay entry '${this.entryName}' because '${this.linkPath}' already exists and is not a symlink.`;
  }
}

export class HomeOverlayPrivateEntrySymlinkError extends Schema.TaggedError<HomeOverlayPrivateEntrySymlinkError>()(
  "HomeOverlayPrivateEntrySymlinkError",
  {
    ...HomeOverlayContext,
    entryName: Schema.String,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Home overlay private entry '${this.entryName}' at '${this.path}' must be a real file, not a symlink.`;
  }
}

export type HomeOverlayError =
  | HomeOverlayFileSystemError
  | HomeOverlayPathConflictError
  | HomeOverlayEntryConflictError
  | HomeOverlayPrivateEntrySymlinkError;

type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotSymlink" }
  | { readonly _tag: "Symlink"; readonly target: string };

// Finder writes .DS_Store into any folder it shows, so it never makes two copies differ.
const IGNORED_CONTENT_NAMES = new Set([".DS_Store"]);

/** Where a directory Move parks an equal source while deleting it. */
export const discardPath = (path: Path.Path, source: string) =>
  path.join(path.dirname(source), `.${path.basename(source)}.t3-discard`);

/** True when both paths hold the same tree: equal names, bytes, executable bits, and link targets. */
export async function sameContent(path: Path.Path, left: string, right: string): Promise<boolean> {
  const inside = (root: string, target: string) =>
    target === root || target.startsWith(`${root}${path.sep}`);
  const compare = async (x: string, y: string): Promise<boolean> => {
    const [a, b] = await Promise.all([NodeFSP.lstat(x), NodeFSP.lstat(y)]);
    if (a.isSymbolicLink() || b.isSymbolicLink()) {
      if (!a.isSymbolicLink() || !b.isSymbolicLink()) return false;
      const [p, q] = await Promise.all([NodeFSP.readlink(x), NodeFSP.readlink(y)]);
      if (p !== q) return false;
      // Equal relative text names different files once it leaves the tree.
      const [from, to] = [path.resolve(path.dirname(x), p), path.resolve(path.dirname(y), q)];
      return from === to || (inside(left, from) && inside(right, to));
    }
    if (a.isFile() && b.isFile()) {
      if (a.size !== b.size || (a.mode & 0o111) !== (b.mode & 0o111)) return false;
      const [p, q] = await Promise.all([NodeFSP.readFile(x), NodeFSP.readFile(y)]);
      return p.equals(q);
    }
    if (!a.isDirectory() || !b.isDirectory()) return false;
    const list = async (directory: string) =>
      (await NodeFSP.readdir(directory)).filter((name) => !IGNORED_CONTENT_NAMES.has(name)).sort();
    const [p, q] = await Promise.all([list(x), list(y)]);
    if (p.length !== q.length || p.some((name, index) => name !== q[index])) return false;
    for (const name of p) {
      if (!(await compare(path.join(x, name), path.join(y, name)))) return false;
    }
    return true;
  };
  return compare(left, right);
}

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

export const materializeHomeOverlay = Effect.fn("materializeHomeOverlay")(function* (
  overlay: HomeOverlay,
): Effect.fn.Return<void, HomeOverlayError, FileSystem.FileSystem | Path.Path> {
  const { sharedRoot, accountDir, policy } = overlay;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const fileSystemError =
    (
      operation: HomeOverlayFileSystemError["operation"],
      filePath: string,
      details: { readonly entryName?: string; readonly targetPath?: string } = {},
    ) =>
    (cause: PlatformError.PlatformError) =>
      new HomeOverlayFileSystemError({
        sharedRoot,
        accountDir,
        operation,
        path: filePath,
        ...details,
        cause,
      });

  const readLinkState = (entryName: string, linkPath: string) =>
    fileSystem.readLink(linkPath).pipe(
      Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
      Effect.catchTags({
        PlatformError: (cause) => {
          if (cause.reason._tag === "NotFound") {
            return Effect.succeed<LinkState>({ _tag: "Missing" });
          }
          if (isNotSymlinkError(cause)) {
            return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
          }
          return Effect.fail(fileSystemError("readLink", linkPath, { entryName })(cause));
        },
      }),
    );

  const remove = (entryName: string, linkPath: string, options?: { recursive: boolean }) =>
    fileSystem
      .remove(linkPath, options)
      .pipe(Effect.mapError(fileSystemError("remove", linkPath, { entryName })));

  const makeDirectory = (directoryPath: string) =>
    fileSystem
      .makeDirectory(directoryPath, { recursive: true })
      .pipe(Effect.mapError(fileSystemError("makeDirectory", directoryPath)));

  const pointsAt = (linkPath: string, state: LinkState, target: string) =>
    state._tag === "Symlink" && path.resolve(path.dirname(linkPath), state.target) === target;

  if (!overlay.active) {
    return yield* Effect.forEach(
      policy.retired,
      Effect.fn("materializeHomeOverlay.retire")(function* (entryName) {
        const linkPath = path.join(accountDir, entryName);
        const state = yield* readLinkState(entryName, linkPath);
        if (pointsAt(linkPath, state, path.join(sharedRoot, entryName))) {
          yield* remove(entryName, linkPath);
        }
      }),
      { discard: true },
    );
  }

  if (sharedRoot === accountDir) {
    return yield* new HomeOverlayPathConflictError({ sharedRoot, accountDir });
  }

  const fold = Effect.fn("materializeHomeOverlay.fold")(function* (
    source: string,
    target: string,
    rule: OverlayFold,
  ): Effect.fn.Return<void, HomeOverlayError> {
    const entryName = path.relative(accountDir, source);
    const conflict = new HomeOverlayEntryConflictError({
      sharedRoot,
      accountDir,
      entryName,
      linkPath: source,
      targetPath: target,
    });
    const sourceState = yield* readLinkState(entryName, source);
    if (sourceState._tag === "Missing") return;
    if (sourceState._tag === "Symlink" || rule._tag === "Conflict") return yield* conflict;
    const info = yield* fileSystem
      .stat(source)
      .pipe(Effect.mapError(fileSystemError("stat", source)));
    if (rule._tag === "Drop") {
      if (info.type !== "File") return yield* conflict;
      return yield* remove(entryName, source);
    }
    const targetState = yield* readLinkState(entryName, target);
    if (rule._tag === "Move") {
      if (info.type !== (rule.kind === "directory" ? "Directory" : "File")) return yield* conflict;
      if (info.type === "Directory") {
        if (targetState._tag === "NotSymlink") {
          const equal = yield* Effect.tryPromise({
            try: () => sameContent(path, source, target),
            catch: (cause) =>
              new HomeOverlayFileSystemError({
                sharedRoot,
                accountDir,
                operation: "stat",
                path: target,
                cause,
              }),
          });
          if (!equal) return yield* conflict;
          // Renamed aside first so a crash mid-delete leaves the entry missing, not half-removed.
          const discarded = discardPath(path, source);
          const parked = yield* Effect.tryPromise({
            try: async () => {
              const stale = await NodeFSP.lstat(discarded).then(
                () => true,
                (cause: NodeJS.ErrnoException) => {
                  if (cause.code === "ENOENT") return false;
                  throw cause;
                },
              );
              // Only an earlier discard, which equals the shared copy, is ours to delete.
              if (stale && !(await sameContent(path, discarded, target))) return false;
              await NodeFSP.rm(discarded, { recursive: true, force: true });
              await NodeFSP.rename(source, discarded);
              await NodeFSP.rm(discarded, { recursive: true, force: true });
              return true;
            },
            catch: (cause) =>
              new HomeOverlayFileSystemError({
                sharedRoot,
                accountDir,
                operation: "remove",
                path: source,
                cause,
              }),
          });
          if (!parked) {
            return yield* new HomeOverlayEntryConflictError({
              sharedRoot,
              accountDir,
              entryName,
              linkPath: discarded,
              targetPath: target,
            });
          }
          return;
        }
        if (targetState._tag !== "Missing") return yield* conflict;
        const missing = yield* Effect.tryPromise({
          try: () =>
            NodeFSP.lstat(target).then(
              () => false,
              (cause: NodeJS.ErrnoException) => {
                if (cause.code === "ENOENT") return true;
                throw cause;
              },
            ),
          catch: (cause) =>
            new HomeOverlayFileSystemError({
              sharedRoot,
              accountDir,
              operation: "stat",
              path: target,
              cause,
            }),
        });
        if (!missing) return yield* conflict;
        return yield* fileSystem.rename(source, target).pipe(
          Effect.catchTags({
            PlatformError: (cause) =>
              cause.reason._tag === "AlreadyExists"
                ? Effect.fail(conflict)
                : Effect.fail(fileSystemError("rename", source, { targetPath: target })(cause)),
          }),
        );
      }
      if (info.type !== "File" || targetState._tag === "Symlink") return yield* conflict;
      const sameFile = Effect.tryPromise({
        try: () => NodeFSP.lstat(target, { bigint: true }),
        catch: (cause) =>
          new HomeOverlayFileSystemError({
            sharedRoot,
            accountDir,
            operation: "stat",
            path: target,
            cause,
          }),
      }).pipe(
        Effect.map(
          (destination) =>
            destination.isFile() &&
            info.dev === destination.dev &&
            Option.isSome(info.ino) &&
            info.ino.value === destination.ino,
        ),
      );
      if (targetState._tag !== "Missing") {
        if (!(yield* sameFile)) return yield* conflict;
      } else {
        yield* fileSystem.link(source, target).pipe(
          Effect.catchTags({
            PlatformError: Effect.fn("materializeHomeOverlay.acceptPublishedFile")(
              function* (cause) {
                if (cause.reason._tag === "AlreadyExists") {
                  if (yield* sameFile) return;
                  return yield* conflict;
                }
                return yield* fileSystemError("link", source, { targetPath: target })(cause);
              },
            ),
          }),
        );
      }
      return yield* remove(entryName, source);
    }
    if (info.type !== "Directory" || targetState._tag === "Symlink") return yield* conflict;
    if (targetState._tag === "NotSymlink") {
      const destination = yield* fileSystem
        .stat(target)
        .pipe(Effect.mapError(fileSystemError("stat", target)));
      if (destination.type !== "Directory") return yield* conflict;
    }
    yield* makeDirectory(target);
    const children = yield* fileSystem
      .readDirectory(source)
      .pipe(Effect.mapError(fileSystemError("readDirectory", source)));
    for (const name of children) {
      yield* fold(path.join(source, name), path.join(target, name), rule.children(name));
    }
    yield* Effect.tryPromise({
      try: () => NodeFSP.rmdir(source),
      catch: (cause) =>
        new HomeOverlayFileSystemError({
          sharedRoot,
          accountDir,
          operation: "remove",
          path: source,
          cause,
        }),
    });
  });

  const ensureLink = Effect.fn("materializeHomeOverlay.ensureLink")(function* (
    entry: OverlayEntry,
  ) {
    const target = path.join(sharedRoot, entry.name);
    const link = path.join(accountDir, entry.name);
    const state = yield* readLinkState(entry.name, link);
    if (pointsAt(link, state, target)) return;

    const symlinkError = fileSystemError("symlink", link, {
      entryName: entry.name,
      targetPath: target,
    });
    const createLink = fileSystem.symlink(target, link).pipe(
      Effect.catchTags({
        PlatformError: Effect.fn("materializeHomeOverlay.acceptRacedLink")(function* (
          cause: PlatformError.PlatformError,
        ) {
          // A peer setup for the same home may have linked it first.
          if (cause.reason._tag === "AlreadyExists") {
            if (pointsAt(link, yield* readLinkState(entry.name, link), target)) return;
          }
          return yield* symlinkError(cause);
        }),
      }),
    );

    if (state._tag === "Missing") return yield* createLink;
    if (state._tag === "Symlink") {
      yield* remove(entry.name, link);
      return yield* createLink;
    }

    if (entry.adopt._tag === "Conflict") {
      return yield* new HomeOverlayEntryConflictError({
        sharedRoot,
        accountDir,
        entryName: entry.name,
        linkPath: link,
        targetPath: target,
      });
    }
    if (entry.adopt._tag === "FoldDirectory" || entry.adopt._tag === "Move") {
      yield* fold(link, target, entry.adopt);
      return yield* createLink;
    }
    const defer = entry.adopt.defer;
    if (defer) {
      const childNames = yield* fileSystem
        .readDirectory(link)
        .pipe(Effect.mapError(fileSystemError("readDirectory", link, { entryName: entry.name })));
      if (defer.when(childNames)) {
        return yield* Effect.logWarning(defer.warning, { path: link });
      }
    }
    yield* remove(entry.name, link, { recursive: true });
    yield* createLink;
  });

  yield* Effect.all([makeDirectory(sharedRoot), makeDirectory(accountDir)], {
    concurrency: "unbounded",
  });

  yield* Effect.forEach(
    policy.mustBeReal,
    Effect.fn("materializeHomeOverlay.rejectLinkedPrivateEntry")(function* (entryName) {
      const entryPath = path.join(accountDir, entryName);
      const state = yield* readLinkState(entryName, entryPath);
      if (state._tag === "Symlink") {
        return yield* new HomeOverlayPrivateEntrySymlinkError({
          sharedRoot,
          accountDir,
          entryName,
          path: entryPath,
        });
      }
    }),
    { discard: true },
  );

  const sharedNames = yield* fileSystem
    .readDirectory(sharedRoot)
    .pipe(Effect.mapError(fileSystemError("readDirectory", sharedRoot)));
  const privateNames = new Set([...policy.mustBeReal, ...policy.healIfLinked]);
  const entries = policy.shared(sharedNames).filter((entry) => !privateNames.has(entry.name));

  yield* Effect.forEach(
    entries.filter((entry) => entry.ensureDirectory),
    (entry) => makeDirectory(path.join(sharedRoot, entry.name)),
    { concurrency: "unbounded", discard: true },
  );

  yield* Effect.forEach(
    policy.healIfLinked,
    Effect.fn("materializeHomeOverlay.healLinkedPrivateEntry")(function* (entryName) {
      const entryPath = path.join(accountDir, entryName);
      const state = yield* readLinkState(entryName, entryPath);
      if (state._tag === "Symlink") yield* remove(entryName, entryPath);
    }),
    { discard: true },
  );

  yield* Effect.forEach(entries, ensureLink, { discard: true });
});
