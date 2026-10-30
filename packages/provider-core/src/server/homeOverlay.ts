import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

/**
 * What to do when a real entry already sits where a shared link belongs.
 * `Replace` removes it (recursively) and links; `defer` keeps it while a live holder may use it.
 */
export type OverlayAdopt =
  | { readonly _tag: "Conflict" }
  | {
      readonly _tag: "Replace";
      readonly defer?: {
        readonly when: (childNames: ReadonlyArray<string>) => boolean;
        readonly warning: string;
      };
    };

export interface OverlayEntry {
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
    operation: Schema.Literals(["readLink", "makeDirectory", "readDirectory", "remove", "symlink"]),
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
