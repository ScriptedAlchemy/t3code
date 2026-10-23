import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  CheckpointScopeId,
  ContextTransferId,
  EventId,
  LOOM_LIMITS,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type LoomWindowInput,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectLoom from "./ProjectLoom.ts";

const projectId = ProjectId.make("loom-project");
const otherProjectId = ProjectId.make("other-project");
const instanceId = ProviderInstanceId.make("codex");
const HOUR = 60 * 60 * 1000;
// Window under test: one week from t0.
const t0 = Date.UTC(2026, 9, 12);
const at = (hours: number) => DateTime.makeUnsafe(t0 + hours * HOUR);
const window = {
  projectId,
  from: DateTime.formatIso(at(0)),
  to: DateTime.formatIso(at(7 * 24)),
} satisfies LoomWindowInput;

const layer = ProjectLoom.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

const read = (input: LoomWindowInput) =>
  Effect.flatMap(ProjectLoom.ProjectLoom, (loom) => loom.readWindow(input));

let sequence = 0;
const apply = (event: Omit<OrchestrationV2DomainEvent, "id">) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (store) =>
    store.apply({
      ...event,
      id: EventId.make(`event-${sequence++}`),
    } as OrchestrationV2DomainEvent),
  );

const createProject = (id: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: sequence++,
      eventId: EventId.make(`project-${id}`),
      aggregateKind: "project",
      aggregateId: id,
      occurredAt: DateTime.formatIso(at(-1000)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: id,
        title: id,
        workspaceRoot: `/work/${id}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(-1000)),
        updatedAt: DateTime.formatIso(at(-1000)),
      },
    }),
  );

interface ThreadSpec {
  readonly id: string;
  readonly createdHours: number;
  readonly updatedHours?: number;
  readonly project?: ProjectId;
  readonly title?: string;
  readonly parent?: { readonly id: string; readonly relationship: "fork" | "subagent" };
  readonly branch?: string;
  readonly deleted?: boolean;
  readonly pullRequestLinkedHours?: number;
  /** Links PRs #1..count at pullRequestLinkedHours, each watched with watchBytes of check names. */
  readonly pullRequestCount?: number;
  readonly watchBytes?: number;
}

const thread = (spec: ThreadSpec) => {
  const threadId = ThreadId.make(spec.id);
  const parentThreadId = spec.parent === undefined ? null : ThreadId.make(spec.parent.id);
  return apply({
    type: "thread.created",
    threadId,
    providerInstanceId: instanceId,
    occurredAt: at(spec.createdHours),
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: spec.project ?? projectId,
      title: spec.title ?? `Thread ${spec.id}`,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: spec.branch ?? null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId,
        relationshipToParent: spec.parent?.relationship ?? null,
        rootThreadId: parentThreadId ?? threadId,
      },
      forkedFrom: null,
      ...(spec.pullRequestLinkedHours === undefined
        ? {}
        : {
            pullRequests: Array.from({ length: spec.pullRequestCount ?? 1 }, (_, index) => {
              const number = spec.pullRequestCount === undefined ? 7 : index + 1;
              return {
                host: "github.com",
                repository: "acme/app",
                number,
                url: `https://github.com/acme/app/pull/${number}`,
                source: "created" as const,
                linkedAt: DateTime.formatIso(at(spec.pullRequestLinkedHours!)),
                snapshot: null,
                stack: null,
                ...(spec.watchBytes === undefined
                  ? {}
                  : {
                      watch: {
                        startedAt: DateTime.formatIso(at(spec.pullRequestLinkedHours!)),
                        headSha: null,
                        failedChecks: ["c".repeat(spec.watchBytes)],
                        passed: false,
                        passedChecks: [],
                        remarksThrough: DateTime.formatIso(at(spec.pullRequestLinkedHours!)),
                        remarkIds: [],
                        conflicting: false,
                        wakes: 0,
                      },
                    }),
              };
            }),
          }),
      createdAt: at(spec.createdHours),
      updatedAt: at(spec.updatedHours ?? spec.createdHours),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: spec.deleted === true ? at(spec.createdHours) : null,
    },
  });
};

interface RunSpec {
  readonly thread: string;
  readonly ordinal: number;
  readonly requestedHours: number;
  readonly startedHours?: number;
  readonly completedHours?: number;
  readonly status?: OrchestrationV2RunStatus;
  readonly model?: string;
  /** When the run last changed; projections bump the thread's updated_at to it. */
  readonly occurredHours?: number;
}

const runId = (spec: Pick<RunSpec, "thread" | "ordinal">) =>
  RunId.make(`${spec.thread}-run-${spec.ordinal}`);

const run = (spec: RunSpec) =>
  apply({
    type: "run.created",
    threadId: ThreadId.make(spec.thread),
    providerInstanceId: instanceId,
    occurredAt: at(
      spec.occurredHours ?? spec.completedHours ?? spec.startedHours ?? spec.requestedHours,
    ),
    payload: {
      id: runId(spec),
      threadId: ThreadId.make(spec.thread),
      ordinal: spec.ordinal,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: spec.model ?? "gpt-5" },
      providerThreadId: null,
      userMessageId: MessageId.make(`${spec.thread}-message-${spec.ordinal}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: spec.status ?? "completed",
      requestedAt: at(spec.requestedHours),
      startedAt: spec.startedHours === undefined ? null : at(spec.startedHours),
      completedAt: spec.completedHours === undefined ? null : at(spec.completedHours),
      checkpointId: null,
      contextHandoffId: null,
    },
  });

const checkpoint = (threadId: string, index: number, hours: number) =>
  apply({
    type: "checkpoint.captured",
    threadId: ThreadId.make(threadId),
    providerInstanceId: instanceId,
    occurredAt: at(hours),
    payload: {
      id: CheckpointId.make(`${threadId}-checkpoint-${index}`),
      threadId: ThreadId.make(threadId),
      scopeId: CheckpointScopeId.make(`${threadId}-scope`),
      runId: null,
      nodeId: NodeId.make(`${threadId}-node`),
      parentCheckpointId: null,
      ordinalWithinScope: index,
      appRunOrdinal: null,
      ref: `refs/t3/${threadId}/${index}` as never,
      status: "ready",
      files: [
        { path: "a.ts", kind: "modified", additions: 3, deletions: 1 },
        { path: "b.ts", kind: "added", additions: 10, deletions: 0 },
      ],
      capturedAt: at(hours),
    },
  });

const command = (spec: {
  readonly thread: string;
  readonly ordinal: number;
  readonly id: string;
  readonly input: string;
  readonly hours: number;
  readonly exitCode?: number;
}) =>
  apply({
    type: "turn-item.updated",
    threadId: ThreadId.make(spec.thread),
    providerInstanceId: instanceId,
    occurredAt: at(spec.hours),
    payload: {
      id: TurnItemId.make(spec.id),
      threadId: ThreadId.make(spec.thread),
      runId: runId(spec),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: at(spec.hours),
      completedAt: at(spec.hours + 0.1),
      updatedAt: at(spec.hours + 0.1),
      type: "command_execution",
      input: spec.input,
      output: "x".repeat(10_000),
      ...(spec.exitCode === undefined ? {} : { exitCode: spec.exitCode }),
    },
  });

const transfer = (spec: {
  readonly id: string;
  readonly type: "fork" | "provider_handoff" | "merge_back";
  readonly source: string;
  readonly target: string;
  readonly hours: number;
}) =>
  apply({
    type: "context-transfer.created",
    threadId: ThreadId.make(spec.target),
    providerInstanceId: instanceId,
    occurredAt: at(spec.hours),
    payload: {
      id: ContextTransferId.make(spec.id),
      type: spec.type,
      sourceThreadId: ThreadId.make(spec.source),
      targetThreadId: ThreadId.make(spec.target),
      sourcePoint: { threadId: ThreadId.make(spec.source) },
      basePoint: null,
      sourceProviderInstanceId: instanceId,
      targetProviderInstanceId: instanceId,
      targetRunId: null,
      status: "consumed",
      resolution: null,
      createdBy: "user",
      error: null,
      createdAt: at(spec.hours),
      updatedAt: at(spec.hours),
      consumedAt: at(spec.hours),
    },
  });

const nativeTask = (threadId: string, id: string, startedHours: number | null) =>
  apply({
    type: "subagent.updated",
    threadId: ThreadId.make(threadId),
    providerInstanceId: instanceId,
    occurredAt: at(startedHours ?? 10),
    payload: {
      id: NodeId.make(id),
      threadId: ThreadId.make(threadId),
      runId: null,
      parentNodeId: NodeId.make(`${threadId}-node`),
      origin: "provider_native",
      createdBy: "agent",
      driver: "claudeAgent" as never,
      providerInstanceId: instanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "explore",
      title: "Explore the repo",
      model: null,
      status: "completed",
      result: null,
      startedAt: startedHours === null ? null : at(startedHours),
      completedAt: null,
      updatedAt: at(startedHours ?? 10),
    },
  });

/** Runs a read while recording the statements it sends, for plan and volume checks. */
const recordReads = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    const record: Statement.Transformer = (statement) => {
      const compiled = statement.compile();
      if (compiled[0].includes("orchestration_v2_projection_")) statements.push(compiled);
      return Effect.succeed(statement);
    };
    const result = yield* effect.pipe(Effect.provideService(Statement.CurrentTransformer, record));
    return { result, statements };
  });

const queryPlans = (statements: ReadonlyArray<readonly [string, ReadonlyArray<unknown>]>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.forEach(statements, ([query, params]) =>
      sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params),
    ),
  ).pipe(Effect.map((plans) => plans.flat().map((row) => row.detail)));

/** Bytes the statements hand back from SQLite, replayed against the same data. */
const bytesRead = (statements: ReadonlyArray<readonly [string, ReadonlyArray<unknown>]>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.forEach(statements, ([query, params]) => sql.unsafe(query, params)),
  ).pipe(Effect.map((rows) => Buffer.byteLength(JSON.stringify(rows))));

const seedProjects = Effect.all([createProject(projectId), createProject(otherProjectId)]);
const repeat = <E, R>(count: number, make: (index: number) => Effect.Effect<void, E, R>) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    make,
    { discard: true },
  );

describe("ProjectLoom.readWindow", () => {
  it.effect("keeps lanes and runs that overlap the window and nothing else", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      yield* thread({ id: "spanning", createdHours: -50, updatedHours: 5 });
      yield* run({
        thread: "spanning",
        ordinal: 1,
        requestedHours: -40,
        startedHours: -39,
        completedHours: -30,
      });
      yield* run({
        thread: "spanning",
        ordinal: 2,
        requestedHours: -2,
        startedHours: -1,
        completedHours: 2,
      });
      yield* thread({ id: "stuck", createdHours: -30, updatedHours: 1 });
      yield* run({ thread: "stuck", ordinal: 2, requestedHours: -10, status: "cancelled" });
      yield* run({
        thread: "stuck",
        ordinal: 1,
        requestedHours: -20,
        status: "running",
        occurredHours: 1,
      });
      yield* thread({ id: "fresh", createdHours: 3 });
      yield* thread({ id: "old", createdHours: -100, updatedHours: -60 });
      yield* run({ thread: "old", ordinal: 1, requestedHours: -90, completedHours: -80 });
      yield* thread({ id: "later", createdHours: 7 * 24 + 1 });

      const result = yield* read(window);
      assert.deepEqual(result.lanes.map((lane) => lane.threadId).toSorted(), [
        "fresh",
        "spanning",
        "stuck",
      ]);
      assert.deepEqual(result.runs.map((entry) => entry.id).toSorted(), [
        "spanning-run-2",
        "stuck-run-1",
      ]);
      const spanning = result.runs.find((entry) => entry.id === "spanning-run-2");
      assert.equal(spanning?.requestedAt, DateTime.formatIso(at(-2)));
      assert.equal(spanning?.startedAt, DateTime.formatIso(at(-1)));
      const stuck = result.runs.find((entry) => entry.id === "stuck-run-1");
      assert.equal(stuck?.startedAt, null);
      assert.equal(stuck?.completedAt, null);
      assert.equal(result.nextCursor, null);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("defaults to the seven days ending now and rejects inverted bounds", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      const result = yield* read({ projectId });
      assert.equal(Date.parse(result.to) - Date.parse(result.from), 7 * 24 * HOUR);
      const inverted = yield* Effect.flip(read({ ...window, from: window.to, to: window.from }));
      assert.equal(inverted.reason, "invalid_window");
      const missing = yield* Effect.flip(read({ projectId: ProjectId.make("nope") }));
      assert.equal(missing.reason, "missing_project");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("pages lanes stably and binds the cursor to the window and filters", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      const total = LOOM_LIMITS.lanes + 10;
      yield* repeat(total, (index) =>
        thread({ id: `lane-${String(index).padStart(3, "0")}`, createdHours: 1 + index }),
      );
      const first = yield* read(window);
      assert.equal(first.lanes.length, LOOM_LIMITS.lanes);
      assert.isTrue(first.truncated.lanes);
      assert.isFalse(first.truncated.runs);
      assert.isNotNull(first.nextCursor);

      // A lane created after the first page must not shift the second.
      yield* thread({ id: "lane-new", createdHours: 100 });
      const second = yield* read({ ...window, cursor: first.nextCursor! });
      assert.equal(second.lanes.length, 10);
      assert.isNull(second.nextCursor);
      assert.isFalse(second.truncated.lanes);
      const seen = new Set([...first.lanes, ...second.lanes].map((lane) => lane.threadId));
      assert.equal(seen.size, total);
      assert.isFalse(seen.has(ThreadId.make("lane-new")));

      const rebound = yield* Effect.flip(
        read({ ...window, cursor: first.nextCursor!, filters: { title: "lane" } }),
      );
      assert.equal(rebound.reason, "invalid_cursor");
      const garbage = yield* Effect.flip(read({ ...window, cursor: "not-a-cursor" }));
      assert.equal(garbage.reason, "invalid_cursor");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("caps runs without touching the other limits", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      yield* thread({ id: "busy", createdHours: 0, updatedHours: 100 });
      yield* repeat(LOOM_LIMITS.runs + 1, (index) =>
        run({
          thread: "busy",
          ordinal: index + 1,
          requestedHours: index * 0.2,
          startedHours: index * 0.2,
          completedHours: index * 0.2 + 0.1,
        }),
      );
      const result = yield* read(window);
      assert.equal(result.runs.length, LOOM_LIMITS.runs);
      assert.deepEqual(result.truncated, {
        lanes: false,
        ancestors: false,
        runs: true,
        markers: false,
        edges: false,
        activity: false,
        bytes: false,
      });
      // The newest runs are kept.
      assert.equal(result.runs[0]?.ordinal, LOOM_LIMITS.runs + 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("caps markers and edges independently", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      yield* thread({ id: "marks", createdHours: 0, updatedHours: 100 });
      yield* thread({ id: "peer", createdHours: 0, updatedHours: 100 });
      yield* repeat(LOOM_LIMITS.markers + 1, (index) => checkpoint("marks", index, index * 0.1));
      yield* repeat(LOOM_LIMITS.edges + 1, (index) =>
        transfer({
          id: `edge-${index}`,
          type: "fork",
          source: "marks",
          target: "peer",
          hours: index * 0.1,
        }),
      );
      const result = yield* read(window);
      assert.equal(result.markers.length, LOOM_LIMITS.markers);
      assert.equal(result.edges.length, LOOM_LIMITS.edges);
      assert.isTrue(result.truncated.markers);
      assert.isTrue(result.truncated.edges);
      assert.isFalse(result.truncated.runs);
      assert.isFalse(result.truncated.lanes);
      assert.isFalse(result.truncated.bytes);
      const [newest] = result.markers;
      assert.equal(newest?.kind, "checkpoint");
      if (newest?.kind === "checkpoint") {
        assert.equal(newest.fileCount, 2);
        assert.equal(newest.additions, 13);
        assert.equal(newest.deletions, 1);
      }
      assert.isAtMost(Buffer.byteLength(JSON.stringify(result)), LOOM_LIMITS.bytes);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports reachable ancestors as stubs and leaves missing ones absent", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      yield* thread({ id: "grandparent", createdHours: -500, updatedHours: -400 });
      yield* thread({
        id: "parent",
        createdHours: -300,
        updatedHours: -200,
        parent: { id: "grandparent", relationship: "fork" },
      });
      yield* thread({
        id: "child",
        createdHours: 5,
        parent: { id: "parent", relationship: "subagent" },
      });
      yield* thread({ id: "deleted-parent", createdHours: -300, deleted: true });
      yield* thread({
        id: "orphan",
        createdHours: 6,
        parent: { id: "deleted-parent", relationship: "fork" },
      });
      yield* thread({ id: "foreign-parent", createdHours: -300, project: otherProjectId });
      yield* thread({
        id: "stray",
        createdHours: 7,
        parent: { id: "foreign-parent", relationship: "fork" },
      });

      const result = yield* read(window);
      assert.deepEqual(result.lanes.map((lane) => lane.threadId).toSorted(), [
        "child",
        "orphan",
        "stray",
      ]);
      const child = result.lanes.find((lane) => lane.threadId === "child");
      assert.equal(child?.relationship, "subagent");
      assert.equal(child?.parentThreadId, "parent");
      assert.deepEqual(
        result.ancestors.map((ancestor) => [ancestor.threadId, ancestor.relationship]),
        [
          ["parent", "fork"],
          ["grandparent", "root"],
        ],
      );
      assert.isFalse(result.truncated.ancestors);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a provider handoff on its own lane as a same-lane edge", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      yield* thread({ id: "switcher", createdHours: 1, updatedHours: 4 });
      yield* transfer({
        id: "handoff",
        type: "provider_handoff",
        source: "switcher",
        target: "switcher",
        hours: 3,
      });
      const result = yield* read(window);
      assert.equal(result.lanes.length, 1);
      assert.deepEqual(
        result.edges.map((edge) => [edge.type, edge.sourceThreadId, edge.targetThreadId]),
        [["provider_handoff", "switcher", "switcher"]],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("labels only recognizable test commands and places PRs at link time", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      yield* thread({
        id: "worker",
        createdHours: 1,
        updatedHours: 20,
        pullRequestLinkedHours: 12,
      });
      yield* run({
        thread: "worker",
        ordinal: 1,
        requestedHours: 2,
        startedHours: 2,
        completedHours: 10,
      });
      yield* command({
        thread: "worker",
        ordinal: 1,
        id: "cmd-test",
        input: "/bin/bash -lc 'cd apps/server && vp test run src/ws.test.ts'",
        hours: 3,
        exitCode: 1,
      });
      yield* command({
        thread: "worker",
        ordinal: 1,
        id: "cmd-echo",
        input: "echo test",
        hours: 4,
      });
      yield* command({
        thread: "worker",
        ordinal: 1,
        id: "cmd-grep",
        input: "grep -rn vitest .",
        hours: 5,
      });
      yield* nativeTask("worker", "task-timed", 6);
      yield* nativeTask("worker", "task-untimed", null);

      const result = yield* read(window);
      const tests = result.markers.filter((marker) => marker.kind === "test_command");
      assert.deepEqual(
        tests.map((marker) => [marker.id, marker.command, marker.exitCode]),
        [["cmd-test", "cd apps/server && vp test run src/ws.test.ts", 1]],
      );
      assert.equal(result.coverage.commandsScanned, 3);
      const pullRequests = result.markers.filter((marker) => marker.kind === "pull_request");
      assert.deepEqual(
        pullRequests.map((marker) => [marker.number, marker.at]),
        [[7, DateTime.formatIso(at(12))]],
      );
      const tasks = result.markers.filter((marker) => marker.kind === "subagent_task");
      assert.deepEqual(
        tasks.map((marker) => marker.id),
        ["task-timed"],
      );
      assert.equal(result.coverage.untimedTasks, 1);
      assert.isFalse(JSON.stringify(result).includes("xxxxxxxx"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("never returns another project's threads or edges into them", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      yield* thread({ id: "mine", createdHours: 1, updatedHours: 5 });
      yield* thread({ id: "theirs", createdHours: 1, updatedHours: 5, project: otherProjectId });
      yield* run({ thread: "theirs", ordinal: 1, requestedHours: 2, completedHours: 3 });
      yield* transfer({
        id: "cross",
        type: "fork",
        source: "mine",
        target: "theirs",
        hours: 2,
      });
      const result = yield* read(window);
      assert.deepEqual(
        result.lanes.map((lane) => lane.threadId),
        ["mine"],
      );
      assert.deepEqual(result.runs, []);
      assert.deepEqual(result.edges, []);
      assert.isFalse(JSON.stringify(result).includes("theirs"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("filters lanes by title, branch, status, provider and model", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      yield* thread({ id: "alpha", title: "Fix login", branch: "main", createdHours: 1 });
      yield* run({
        thread: "alpha",
        ordinal: 1,
        requestedHours: 2,
        completedHours: 3,
        status: "failed",
      });
      yield* thread({ id: "beta", title: "Add billing", branch: "feature", createdHours: 1 });
      yield* run({
        thread: "beta",
        ordinal: 1,
        requestedHours: 2,
        completedHours: 3,
        model: "claude-opus",
      });
      const lanes = (filters: LoomWindowInput["filters"]) =>
        read({ ...window, ...(filters === undefined ? {} : { filters }) }).pipe(
          Effect.map((result) => result.lanes.map((lane) => lane.threadId)),
        );
      assert.deepEqual(yield* lanes({ title: "LOGIN" }), ["alpha"]);
      assert.deepEqual(yield* lanes({ branches: ["feature"] }), ["beta"]);
      assert.deepEqual(yield* lanes({ statuses: ["failed"] }), ["alpha"]);
      assert.deepEqual(yield* lanes({ models: ["claude-opus"] }), ["beta"]);
      assert.deepEqual(
        yield* lanes({ providerInstanceIds: [ProviderInstanceId.make("other")] }),
        [],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "keeps older lanes whose only activity in the window is a marker or an active run",
    () =>
      Effect.gen(function* () {
        yield* seedProjects;
        // Each thread and its runs predate the window; only the named activity falls inside it.
        const older = (id: string, extra: Partial<ThreadSpec> = {}) =>
          Effect.andThen(thread({ id, createdHours: -100, updatedHours: -90, ...extra }), () =>
            run({ thread: id, ordinal: 1, requestedHours: -95, completedHours: -94 }),
          );
        yield* older("still-running");
        yield* run({
          thread: "still-running",
          ordinal: 2,
          requestedHours: -20,
          startedHours: -19,
          status: "running",
        });
        yield* older("late-checkpoint");
        yield* checkpoint("late-checkpoint", 0, 5);
        yield* older("linked-later", { pullRequestLinkedHours: 12 });
        yield* older("native-task");
        yield* nativeTask("native-task", "native-task-1", 6);
        yield* older("merge-target");
        yield* thread({ id: "merge-source", createdHours: 2 });
        yield* transfer({
          id: "merge",
          type: "merge_back",
          source: "merge-source",
          target: "merge-target",
          hours: 8,
        });
        yield* older("quiet");

        const result = yield* read(window);
        assert.deepEqual(result.lanes.map((lane) => lane.threadId).toSorted(), [
          "late-checkpoint",
          "linked-later",
          "merge-source",
          "merge-target",
          "native-task",
          "still-running",
        ]);
        assert.deepEqual(
          result.runs.map((entry) => entry.id),
          ["still-running-run-2"],
        );
        assert.deepEqual(result.markers.map((marker) => marker.kind).toSorted(), [
          "checkpoint",
          "pull_request",
          "subagent_task",
        ]);
        assert.deepEqual(
          result.edges.map((edge) => edge.id),
          ["merge"],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("gives a fork and its parent distinct markers for the same pull request", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      yield* thread({ id: "parent", createdHours: 1, pullRequestLinkedHours: 3 });
      yield* thread({
        id: "fork",
        createdHours: 2,
        parent: { id: "parent", relationship: "fork" },
        pullRequestLinkedHours: 3,
      });
      const result = yield* read(window);
      const pullRequests = result.markers.filter((marker) => marker.kind === "pull_request");
      assert.deepEqual(pullRequests.map((marker) => marker.threadId).toSorted(), [
        "fork",
        "parent",
      ]);
      assert.equal(new Set(pullRequests.map((marker) => marker.id)).size, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the whole response under the byte cap when lane text is huge", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      const huge = "t".repeat(300 * 1024);
      yield* thread({ id: "ancestor", createdHours: -500, updatedHours: -400, title: huge });
      yield* thread({
        id: "verbose",
        createdHours: 1,
        title: huge,
        branch: huge,
        parent: { id: "ancestor", relationship: "fork" },
      });
      const { result, statements } = yield* recordReads(read(window));
      assert.deepEqual(
        result.lanes.map((lane) => lane.threadId),
        ["verbose"],
      );
      assert.deepEqual(
        result.ancestors.map((ancestor) => ancestor.threadId),
        ["ancestor"],
      );
      assert.isAtMost(Buffer.byteLength(JSON.stringify(result)), LOOM_LIMITS.bytes);
      assert.isBelow(yield* bytesRead(statements), 64 * 1024);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads pull request links compactly and flags the ones past the marker cap", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      yield* thread({
        id: "linked",
        createdHours: 1,
        pullRequestLinkedHours: 2,
        pullRequestCount: LOOM_LIMITS.markers + 200,
        watchBytes: 2_000,
      });
      const { result, statements } = yield* recordReads(read(window));
      assert.isTrue(result.truncated.markers);
      assert.isAtMost(result.markers.length, LOOM_LIMITS.markers);
      // The links' watches total 2.4 MB; only compact marker fields should leave SQLite.
      assert.isBelow(yield* bytesRead(statements), 512 * 1024);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("bounds the untimed task count and says when it hit the bound", () =>
    Effect.gen(function* () {
      yield* seedProjects;
      yield* thread({ id: "tasks", createdHours: 1, updatedHours: 20 });
      yield* repeat(LOOM_LIMITS.markers + 2, (index) =>
        nativeTask("tasks", `untimed-${index}`, null),
      );
      const result = yield* read(window);
      assert.equal(result.coverage.untimedTasks, LOOM_LIMITS.markers);
      assert.isTrue(result.coverage.untimedTasksTruncated);
    }).pipe(Effect.provide(layer)),
  );

  describe("query plans", () => {
    const seedBusyLane = Effect.gen(function* () {
      yield* seedProjects;
      yield* thread({ id: "busy", createdHours: -400, updatedHours: 10 });
      yield* run({ thread: "busy", ordinal: 1, requestedHours: -300, completedHours: -299 });
      yield* run({
        thread: "busy",
        ordinal: 2,
        requestedHours: 2,
        startedHours: 2,
        completedHours: 3,
      });
      yield* command({ thread: "busy", ordinal: 2, id: "cmd", input: "vp test run", hours: 2.5 });
      yield* nativeTask("busy", "task", 4);
      return yield* recordReads(read(window));
    });

    it.effect("reads native tasks by lane, not by the child thread index", () =>
      Effect.gen(function* () {
        const plans = yield* queryPlans((yield* seedBusyLane).statements);
        assert.isFalse(plans.some((detail) => detail.includes("subagents_child_thread_idx")));
        assert.isTrue(plans.some((detail) => detail.includes("subagents_thread_idx")));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("bounds every run read by the window instead of a lane's whole history", () =>
      Effect.gen(function* () {
        const plans = yield* queryPlans((yield* seedBusyLane).statements);
        const runReads = plans.filter((detail) =>
          /USING .*INDEX orchestration_v2_projection_runs_/.test(detail),
        );
        assert.isNotEmpty(runReads);
        // A requested_at search with only an upper bound walks every earlier run of the lane.
        assert.isFalse(
          runReads.some(
            (detail) => /requested_at<\?\)/.test(detail) && !/requested_at>\?/.test(detail),
          ),
        );
        assert.isTrue(runReads.some((detail) => detail.includes("runs_thread_completed_idx")));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("orders command candidates from a covering index, never sorting payloads", () =>
      Effect.gen(function* () {
        const plans = yield* queryPlans((yield* seedBusyLane).statements);
        assert.isTrue(
          plans.some((detail) =>
            detail.includes(
              "COVERING INDEX orchestration_v2_projection_turn_items_run_command_updated_idx",
            ),
          ),
        );
      }).pipe(Effect.provide(layer)),
    );
  });
});
