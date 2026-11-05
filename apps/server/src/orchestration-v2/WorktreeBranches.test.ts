import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  RunId,
  ThreadId,
  type CommandId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as WorktreeBranches from "./WorktreeBranches.ts";

interface MetadataUpdate {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly branch: string;
  readonly expectedBranch: string | null;
  readonly expectedWorktreePath: string;
}

const gitLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "worktree-branches-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const member = (
  id: string,
  branch: string | null,
  worktreePath: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
) =>
  ({
    id: ThreadId.make(id),
    branch,
    worktreePath,
    activeRunId: null,
    archivedAt: null,
    createdAt: DateTime.makeUnsafe(0),
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "worktree-sync-" }));
  const repo = `${root}/repo`;
  const worktree = `${root}/feature`;
  yield* fs.makeDirectory(repo);
  const command = (cwd: string, args: string[]) =>
    git
      .execute({ operation: "worktree-branches-test", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* command(repo, ["init", "-b", "main"]);
  yield* command(repo, ["config", "user.email", "branches@example.test"]);
  yield* command(repo, ["config", "user.name", "Branches test"]);
  yield* command(repo, ["commit", "--allow-empty", "-m", "initial"]);
  yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);

  let threads: OrchestrationV2ThreadShell[] = [];
  let snapshotReads = 0;
  let onDispatch: (update: MetadataUpdate) => Effect.Effect<void> = () => Effect.void;
  const dispatched: MetadataUpdate[] = [];
  const context = yield* Layer.build(WorktreeBranches.layer).pipe(
    Effect.provideService(ProjectStore.ProjectStoreV2, {
      getShell: () => Effect.succeedSome({ workspaceRoot: repo }),
    } as unknown as ProjectStore.ProjectStoreV2["Service"]),
    Effect.provideService(Orchestrator.OrchestratorV2, {
      getShellSnapshot: (options: { readonly worktreePath: string }) =>
        Effect.sync(() => {
          snapshotReads++;
          const members = threads.filter((thread) => thread.worktreePath === options.worktreePath);
          return {
            threads: members.filter((thread) => thread.archivedAt === null),
            archivedThreads: members.filter((thread) => thread.archivedAt !== null),
          };
        }),
      dispatch: (update: MetadataUpdate) =>
        Effect.gen(function* () {
          yield* onDispatch(update);
          dispatched.push(update);
          threads = threads.map((thread) =>
            thread.id === update.threadId &&
            thread.branch === update.expectedBranch &&
            thread.worktreePath === update.expectedWorktreePath
              ? { ...thread, branch: update.branch }
              : thread,
          );
        }),
    } as unknown as Orchestrator.OrchestratorV2["Service"]),
  );
  return {
    service: Context.get(context, WorktreeBranches.WorktreeBranches),
    command,
    repo,
    worktree,
    dispatched,
    snapshotReads: () => snapshotReads,
    threads: () => threads,
    setThreads: (next: OrchestrationV2ThreadShell[]) => {
      threads = next;
    },
    onDispatch: (hook: (update: MetadataUpdate) => Effect.Effect<void>) => {
      onDispatch = hook;
    },
  };
});

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | Scope.Scope
    | FileSystem.FileSystem
    | GitVcsDriver.GitVcsDriver
    | Path.Path
    | ServerConfig.ServerConfig
  >,
) => effect.pipe(Effect.provide(gitLayer), Effect.scoped);

it.live("returns Bound without reading threads when every record matches HEAD", () =>
  run(
    Effect.gen(function* () {
      const { service, worktree, snapshotReads, dispatched } = yield* fixture;
      assert.deepEqual(yield* service.sync({ worktreePath: worktree, recorded: ["feature"] }), {
        _tag: "Bound",
        branch: "feature",
      });
      assert.equal(snapshotReads(), 0);
      assert.deepEqual(dispatched, []);
    }),
  ),
);

it.live("writes every member oldest first, each with its own swap, and a repeat is Bound", () =>
  run(
    Effect.gen(function* () {
      const { service, command, worktree, dispatched, threads, setThreads } = yield* fixture;
      yield* command(worktree, ["switch", "-c", "agent/work"]);
      setThreads([
        member("child", "t3/old", worktree, { createdAt: DateTime.makeUnsafe(2) }),
        member("no-branch", null, worktree, { createdAt: DateTime.makeUnsafe(3) }),
        member("archived", "feature", worktree, {
          createdAt: DateTime.makeUnsafe(4),
          archivedAt: DateTime.makeUnsafe(5),
        }),
        member("parent", "feature", worktree, { createdAt: DateTime.makeUnsafe(1) }),
        member("elsewhere", "feature", `${worktree}-other`),
      ]);
      assert.deepEqual(yield* service.sync({ worktreePath: worktree, recorded: ["feature"] }), {
        _tag: "Rebinding",
        branch: "agent/work",
      });
      assert.deepEqual(
        dispatched.map((update) => [update.threadId, update.expectedBranch]),
        [
          ["parent", "feature"],
          ["child", "t3/old"],
          ["no-branch", null],
          ["archived", "feature"],
        ],
      );
      assert.isTrue(dispatched.every((update) => update.expectedWorktreePath === worktree));
      assert.equal(new Set(dispatched.map((update) => update.commandId)).size, 4);
      assert.equal(threads().find((thread) => thread.id === "elsewhere")?.branch, "feature");
      assert.deepEqual(
        yield* service.sync({
          worktreePath: worktree,
          recorded: ["parent", "child", "no-branch", "archived"].map(
            (id) => threads().find((thread) => thread.id === id)!.branch,
          ),
        }),
        { _tag: "Bound", branch: "agent/work" },
      );
    }),
  ),
);

it.live.each([
  ["a detached HEAD", ["switch", "--detach"], "Detached", undefined],
  ["an unborn branch", ["switch", "--orphan", "unborn"], "Unavailable", undefined],
  ["a parenthesized name", ["switch", "-c", "(feature)"], "Unavailable", undefined],
  ["the default branch", ["switch", "main"], "Unbound", "main"],
] as const)("writes nothing for %s", ([, checkout, tag, branch]) =>
  run(
    Effect.gen(function* () {
      const { service, command, repo, worktree, dispatched, setThreads } = yield* fixture;
      setThreads([member("thread", "feature", worktree)]);
      if (branch === "main") yield* command(repo, ["switch", "--detach"]);
      yield* command(worktree, [...checkout]);
      assert.deepEqual(yield* service.sync({ worktreePath: worktree, recorded: ["feature"] }), {
        _tag: tag,
        ...(branch === undefined ? {} : { branch }),
      } as WorktreeBranches.WorktreeCheckout);
      assert.deepEqual(dispatched, []);
    }),
  ),
);

it.live("writes nothing for a branch another checkout holds", () =>
  run(
    Effect.gen(function* () {
      const { service, command, repo, worktree, dispatched, setThreads } = yield* fixture;
      setThreads([member("thread", "feature", worktree)]);
      yield* command(repo, ["switch", "-c", "trunk"]);
      yield* command(worktree, ["switch", "--ignore-other-worktrees", "trunk"]);
      assert.deepEqual(yield* service.sync({ worktreePath: worktree, recorded: ["feature"] }), {
        _tag: "Unbound",
        branch: "trunk",
      });
      assert.deepEqual(dispatched, []);
    }),
  ),
);

it.live("writes nothing when another repository replaced the worktree", () =>
  run(
    Effect.gen(function* () {
      const { service, command, worktree, dispatched, setThreads } = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const other = yield* fs.makeTempDirectoryScoped({ prefix: "worktree-sync-other-" });
      yield* command(other, ["init", "-b", "main"]);
      yield* command(other, ["config", "user.email", "other@example.test"]);
      yield* command(other, ["config", "user.name", "Other"]);
      yield* command(other, ["commit", "--allow-empty", "-m", "unrelated"]);
      yield* fs.rename(worktree, `${worktree}-original`);
      yield* command(other, ["worktree", "add", "-b", "other-work", worktree]);
      setThreads([member("thread", "feature", worktree)]);
      assert.deepEqual(yield* service.sync({ worktreePath: worktree, recorded: ["feature"] }), {
        _tag: "Unavailable",
      });
      assert.deepEqual(dispatched, []);
    }),
  ),
);

it.live("reads the default branch from the primary remote before main or master", () =>
  run(
    Effect.gen(function* () {
      const { service, command, repo, worktree, dispatched, setThreads } = yield* fixture;
      setThreads([member("thread", "feature", worktree)]);
      yield* command(repo, ["branch", "trunk", "main"]);
      yield* command(repo, ["remote", "add", "origin", repo]);
      yield* command(repo, ["fetch", "origin"]);
      yield* command(repo, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/trunk",
      ]);
      yield* command(worktree, ["switch", "trunk"]);
      assert.equal(
        (yield* service.sync({ worktreePath: worktree, recorded: ["feature"] }))._tag,
        "Unbound",
      );
      assert.deepEqual(dispatched, []);
      yield* command(repo, ["switch", "--detach"]);
      yield* command(worktree, ["switch", "main"]);
      assert.equal(
        (yield* service.sync({ worktreePath: worktree, recorded: ["feature"] }))._tag,
        "Rebinding",
      );
    }),
  ),
);

it.live("reports a missing worktree as Unavailable", () =>
  run(
    Effect.gen(function* () {
      const { service, worktree } = yield* fixture;
      const missing = `${worktree}-missing`;
      assert.deepEqual(yield* service.observe(missing), { _tag: "Unavailable" });
      assert.deepEqual(yield* service.sync({ worktreePath: missing, recorded: ["feature"] }), {
        _tag: "Unavailable",
      });
    }),
  ),
);

it.live("defers to a sibling's active run but writes through the caller's own", () =>
  run(
    Effect.gen(function* () {
      const { service, command, worktree, dispatched, setThreads } = yield* fixture;
      const runId = RunId.make("run-own");
      yield* command(worktree, ["switch", "-c", "agent/work"]);
      setThreads([
        member("own", "feature", worktree, { activeRunId: runId }),
        member("sibling", "feature", worktree, { activeRunId: RunId.make("run-sibling") }),
      ]);
      const sync = { worktreePath: worktree, recorded: ["feature"], runId };
      assert.deepEqual(yield* service.sync(sync), { _tag: "Rebinding", branch: "agent/work" });
      assert.deepEqual(dispatched, []);
      setThreads([
        member("own", "feature", worktree, { activeRunId: runId }),
        member("sibling", "feature", worktree),
      ]);
      yield* service.sync(sync);
      assert.deepEqual(dispatched.map((update) => update.threadId).toSorted(), ["own", "sibling"]);
    }),
  ),
);

it.live("logs a lost swap and still writes the next member", () =>
  run(
    Effect.gen(function* () {
      const { service, command, worktree, threads, setThreads, onDispatch } = yield* fixture;
      yield* command(worktree, ["switch", "-c", "agent/work"]);
      setThreads([
        member("first", "feature", worktree, { createdAt: DateTime.makeUnsafe(1) }),
        member("second", "feature", worktree, { createdAt: DateTime.makeUnsafe(2) }),
      ]);
      onDispatch((update) => (update.threadId === "first" ? Effect.die("swap lost") : Effect.void));
      assert.equal(
        (yield* service.sync({ worktreePath: worktree, recorded: ["feature"] }))._tag,
        "Rebinding",
      );
      assert.deepEqual(
        threads().map((thread) => thread.branch),
        ["feature", "agent/work"],
      );
    }),
  ),
);

it.live("picks up a child created during the write when it rereads", () =>
  run(
    Effect.gen(function* () {
      const { service, command, worktree, threads, setThreads, onDispatch } = yield* fixture;
      yield* command(worktree, ["switch", "-c", "agent/work"]);
      setThreads([member("parent", "feature", worktree)]);
      onDispatch((update) =>
        Effect.sync(() => {
          if (update.threadId === "parent")
            setThreads([...threads(), member("child", "feature", worktree)]);
        }),
      );
      yield* service.sync({ worktreePath: worktree, recorded: ["feature"] });
      assert.deepEqual(
        threads().map((thread) => thread.branch),
        ["agent/work", "agent/work"],
      );
    }),
  ),
);

it.live("terminates when every write is rejected", () =>
  run(
    Effect.gen(function* () {
      const { service, command, worktree, setThreads, onDispatch } = yield* fixture;
      yield* command(worktree, ["switch", "-c", "agent/work"]);
      setThreads([member("parent", "feature", worktree)]);
      onDispatch(() => Effect.die("rejected"));
      assert.equal(
        (yield* service.sync({ worktreePath: worktree, recorded: ["feature"] }))._tag,
        "Rebinding",
      );
    }),
  ),
);
