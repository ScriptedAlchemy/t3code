// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native containment needs lstat, realpath, and atomic file replacement.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as AcpErrors from "effect-acp/errors";

import { sameContent } from "@t3tools/provider-core/server/homeOverlay";

/** ACP 1.4.1 rejects skill links escaping a native root after realpath resolution. */
export const prepareAntigravitySkillSnapshot = Effect.fn("prepareAntigravitySkillSnapshot")(
  function* (input: {
    readonly sourceDirectory: string;
    readonly snapshotDirectory: string;
    readonly libraryDirectory: string;
    readonly platform: NodeJS.Platform;
  }) {
    const path = yield* Path.Path;
    return yield* Effect.tryPromise({
      try: async () => {
        const stat = (filePath: string) =>
          NodeFSP.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
        const within = (root: string, candidate: string) =>
          candidate === root || candidate.startsWith(`${root}${path.sep}`);
        const sourceRoot = await NodeFSP.realpath(input.sourceDirectory);
        const entries = await NodeFSP.readdir(sourceRoot);
        const libraryTarget = (source: string) =>
          path.join(input.libraryDirectory, path.basename(source));
        const isLibraryLink = async (source: string) =>
          (await stat(source))?.isSymbolicLink() === true &&
          path.resolve(path.dirname(source), await NodeFSP.readlink(source)) ===
            libraryTarget(source);
        let needed = false;
        for (const entry of entries) needed ||= await isLibraryLink(path.join(sourceRoot, entry));
        if (!needed) return input.sourceDirectory;

        const directory = async (target: string) => {
          const current = await stat(target);
          if (current?.isSymbolicLink())
            throw new Error(`Skill snapshot directory is a link: ${target}`);
          if (current !== undefined && !current.isDirectory())
            throw new Error(`Skill snapshot directory is not a directory: ${target}`);
          await NodeFSP.mkdir(target, { recursive: true });
        };
        await directory(path.dirname(input.snapshotDirectory));
        await directory(input.snapshotDirectory);

        const copy = async (
          source: string,
          target: string,
          fromRoot: string,
          toRoot: string,
        ): Promise<void> => {
          const sourceInfo = await NodeFSP.lstat(source);
          const targetInfo = await stat(target);
          if (sourceInfo.isSymbolicLink()) {
            const original = path.resolve(path.dirname(source), await NodeFSP.readlink(source));
            if (
              fromRoot === sourceRoot &&
              path.dirname(source) === sourceRoot &&
              original === libraryTarget(source)
            ) {
              await copy(original, target, original, target);
              return;
            }
            // Internal links follow their copied tree; outside links keep their original boundary.
            const destination = within(fromRoot, original)
              ? path.join(toRoot, path.relative(fromRoot, original))
              : original;
            if (targetInfo?.isSymbolicLink() && (await NodeFSP.readlink(target)) === destination)
              return;
            if (targetInfo !== undefined)
              await NodeFSP.rm(target, { recursive: true, force: true });
            const isDirectory = await NodeFSP.stat(source).then(
              (info) => info.isDirectory(),
              () => false,
            );
            await NodeFSP.symlink(
              destination,
              target,
              input.platform === "win32" && isDirectory ? "junction" : undefined,
            );
          } else if (sourceInfo.isDirectory()) {
            if (
              targetInfo !== undefined &&
              (!targetInfo.isDirectory() || targetInfo.isSymbolicLink())
            )
              await NodeFSP.rm(target, { recursive: true, force: true });
            await NodeFSP.mkdir(target, { recursive: true });
            const names = await NodeFSP.readdir(source);
            for (const name of names)
              await copy(path.join(source, name), path.join(target, name), fromRoot, toRoot);
            for (const name of await NodeFSP.readdir(target)) {
              if (!names.includes(name))
                await NodeFSP.rm(path.join(target, name), { recursive: true, force: true });
            }
          } else if (sourceInfo.isFile()) {
            if (targetInfo?.isFile() && (await sameContent(path, source, target))) return;
            if (targetInfo !== undefined && !targetInfo.isFile())
              await NodeFSP.rm(target, { recursive: true, force: true });
            const staging = await NodeFSP.mkdtemp(path.join(path.dirname(target), ".t3-skill-"));
            try {
              const staged = path.join(staging, "content");
              await NodeFSP.copyFile(source, staged, NodeFSP.constants.COPYFILE_FICLONE);
              await NodeFSP.chmod(staged, sourceInfo.mode);
              await NodeFSP.rename(staged, target);
            } finally {
              await NodeFSP.rm(staging, { recursive: true, force: true });
            }
          } else {
            throw new Error(`Unsupported skill file: ${source}`);
          }
        };
        await copy(sourceRoot, input.snapshotDirectory, sourceRoot, input.snapshotDirectory);
        return input.snapshotDirectory;
      },
      catch: (cause) =>
        new AcpErrors.AcpTransportError({
          detail:
            "Antigravity could not prepare readable shared skills. Resolve the filesystem error and retry.",
          cause,
        }),
    });
  },
  // Filesystem promises keep running after interruption; finish before releasing the profile lock.
  Effect.uninterruptible,
);
