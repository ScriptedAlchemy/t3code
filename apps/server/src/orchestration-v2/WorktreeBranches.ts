import { CommandId, GitCommandError, type RunId } from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as Orchestrator from "./Orchestrator.ts";

export type WorktreeHead =
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Detached" }
  | { readonly _tag: "Named"; readonly branch: string };

export type WorktreeCheckout =
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Detached" }
  /** HEAD is on the default branch and records differ. Its own ref holds HEAD, so nothing is written. */
  | { readonly _tag: "Default"; readonly branch: string }
  | { readonly _tag: "Bound"; readonly branch: string }
  /** Records differ, and a write was attempted or deferred. The caller's thread data is stale. */
  | { readonly _tag: "Rebinding"; readonly branch: string };

type WorktreeBranchError = GitCommandError | PlatformError;

export class WorktreeBranches extends Context.Service<
  WorktreeBranches,
  {
    readonly observe: (worktreePath: string) => Effect.Effect<WorktreeHead, WorktreeBranchError>;
    /** `runId` names the one run allowed to stay active while this worktree's threads are written. */
    readonly sync: (input: {
      readonly worktreePath: string;
      readonly recorded: ReadonlyArray<string | null>;
      readonly runId?: RunId;
    }) => Effect.Effect<WorktreeCheckout, WorktreeBranchError>;
  }
>()("t3/orchestration-v2/WorktreeBranches") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const observe: WorktreeBranches["Service"]["observe"] = Effect.fn("WorktreeBranches.observe")(
    function* (cwd) {
      const failure = (detail: string) =>
        new GitCommandError({
          operation: "WorktreeBranches.observe",
          command: "git",
          cwd,
          detail,
        });
      // Return null for missing/non-repository cwd; force untranslated git diagnostics for matching.
      const read = Effect.fnUntraced(function* (args: string[], allowedExitCode?: number) {
        const result = yield* git
          .execute({
            operation: "WorktreeBranches.observe",
            cwd,
            args,
            env: { LC_ALL: "C" },
            allowNonZeroExit: true,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.flatMap(fs.exists(cwd), (exists) =>
                exists ? Effect.fail(error) : Effect.succeed(null),
              ),
            ),
          );
        if (result === null) return null;
        if (result.exitCode === 0 || result.exitCode === allowedExitCode) return result;
        const stderr = result.stderr.toLowerCase();
        // Newer Git reports a dangling .git file as "gitfile does not point to a valid repository".
        if (
          stderr.includes("not a git repository") ||
          stderr.includes("does not point to a valid repository")
        )
          return null;
        return yield* failure(
          result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
        );
      });
      const index = yield* read(["rev-parse", "--git-path", "index"]);
      if (index === null) return { _tag: "Unavailable" };
      if (yield* fs.exists(`${path.resolve(cwd, index.stdout.trim())}.lock`))
        return yield* failure(
          "Git index is locked. Status will resume when the index lock is removed.",
        );
      // Detached HEAD exits 1; full refs avoid shortening when a tag shares the branch name.
      const head = yield* read(["symbolic-ref", "--quiet", "HEAD"], 1);
      if (head === null) return { _tag: "Unavailable" };
      if (head.exitCode !== 0) return { _tag: "Detached" };
      const ref = head.stdout.trim();
      const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length).trim() : null;
      return branch === null || branch.startsWith("(")
        ? { _tag: "Unavailable" }
        : { _tag: "Named", branch };
    },
  );

  const isDefaultBranch = Effect.fn("WorktreeBranches.isDefaultBranch")(function* (
    cwd: string,
    branch: string,
  ) {
    const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
    return GitVcsDriver.isDefaultBranchName(
      branch,
      remote === null ? null : yield* git.resolveDefaultBranchName(cwd, remote),
    );
  });

  const writeMembers = Effect.fn("WorktreeBranches.writeMembers")(function* (input: {
    readonly worktreePath: string;
    readonly branch: string;
    readonly runId: RunId | undefined;
  }) {
    const { worktreePath, branch, runId } = input;
    // Oldest first so parents are written before children; reread for threads created mid-write.
    const visited = new Set<string>();
    while (true) {
      const snapshot = yield* orchestrator.getShellSnapshot({ worktreePath });
      const members = [...snapshot.threads, ...snapshot.archivedThreads];
      // A sibling's agent may be mid-checkout, so HEAD proves nothing yet. Its run end syncs.
      if (members.some((member) => member.activeRunId !== null && member.activeRunId !== runId))
        return;
      const pending = members
        .filter((member) => !visited.has(member.id) && member.branch !== branch)
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
        );
      if (pending.length === 0) return;
      for (const member of pending) {
        visited.add(member.id);
        // Random ids: a deterministic receipt would block a later A to B to A to B sequence.
        const uuid = yield* randomUuidV4;
        yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`server:worktree-branch:${member.id}:${uuid}`),
            threadId: member.id,
            branch,
            expectedBranch: member.branch,
            expectedWorktreePath: worktreePath,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("worktree branch update failed", {
                threadId: member.id,
                branch,
                cause,
              }),
            ),
          );
      }
    }
  });

  const sync: WorktreeBranches["Service"]["sync"] = Effect.fn("WorktreeBranches.sync")(function* ({
    worktreePath,
    recorded,
    runId,
  }) {
    const head = yield* observe(worktreePath);
    if (head._tag !== "Named") return head;
    const { branch } = head;
    if (recorded.every((name) => name === branch)) return { _tag: "Bound", branch };
    const born = yield* git.execute({
      operation: "WorktreeBranches.sync",
      cwd: worktreePath,
      args: ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      allowNonZeroExit: true,
    });
    if (born.exitCode !== 0) return { _tag: "Unavailable" };
    if (yield* isDefaultBranch(worktreePath, branch)) return { _tag: "Default", branch };
    yield* writeMembers({ worktreePath, branch, runId }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("worktree branch sync could not read its threads", {
          worktreePath,
          branch,
          cause,
        }),
      ),
    );
    return { _tag: "Rebinding", branch };
  });

  return WorktreeBranches.of({ observe, sync });
});

export const layer = Layer.effect(WorktreeBranches, make);
