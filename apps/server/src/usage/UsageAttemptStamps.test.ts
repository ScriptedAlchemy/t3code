import { assert, it } from "@effect/vitest";
import { ProjectId, RunAttemptId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageAttemptStamps from "./UsageAttemptStamps.ts";

const projectId = ProjectId.make("project-stamps");
const attemptId = RunAttemptId.make("attempt-stamps");
const threadId = ThreadId.make("thread-stamps");
const input = {
  attemptId,
  threadId,
  projectId,
  message: { createdBy: "user", creationSource: "web" },
} as const satisfies UsageAttemptStamps.UsageAttemptStampInput;

const layer = UsageAttemptStamps.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(
    ServerSettings.layerTest({
      enableModelEvaluations: true,
      projectSettingsOverrides: { [projectId]: { enableAssistedLearning: true } },
    }),
  ),
);

const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly origin: string;
    readonly settings_json: string;
  }>`SELECT origin, settings_json FROM usage_attempt_stamps WHERE attempt_id = ${attemptId}`;
});

it.effect("overwrites the stamp when the same attempt is stamped again", () =>
  Effect.gen(function* () {
    const stamps = yield* UsageAttemptStamps.UsageAttemptStamps;
    yield* stamps.stamp(input);
    yield* stamps.stamp({
      ...input,
      message: {
        createdBy: "user",
        creationSource: "web",
        scheduledTaskId: ScheduledTaskId.make("task-1"),
      },
    });

    const stored = yield* rows;
    assert.deepStrictEqual(
      stored.map((row) => row.origin),
      ["scheduled"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("stores only booleans, resolved for the project", () =>
  Effect.gen(function* () {
    yield* (yield* UsageAttemptStamps.UsageAttemptStamps).stamp(input);

    const [row] = yield* rows;
    const settings = JSON.parse(row!.settings_json) as Record<string, unknown>;
    assert.isTrue(Object.values(settings).every((value) => typeof value === "boolean"));
    assert.strictEqual(settings.enableModelEvaluations, true);
    assert.strictEqual(settings.enableAssistedLearning, true);
    assert.strictEqual(settings.pstackEnabled, false);
    assert.notProperty(settings, "textGenerationModelSelection");
  }).pipe(Effect.provide(layer)),
);

it.effect("does not fail the caller when the write fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE usage_attempt_stamps`;

    yield* (yield* UsageAttemptStamps.UsageAttemptStamps).stamp(input);
  }).pipe(Effect.provide(layer)),
);

it.effect("does not fail the caller when reading settings dies", () =>
  Effect.gen(function* () {
    yield* (yield* UsageAttemptStamps.UsageAttemptStamps).stamp(input);

    assert.deepStrictEqual(yield* rows, []);
  }).pipe(
    Effect.provide(
      UsageAttemptStamps.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(
          Layer.effect(
            ServerSettings.ServerSettingsService,
            Effect.gen(function* () {
              const settings = yield* ServerSettings.ServerSettingsService;
              return { ...settings, getSettings: Effect.die("settings blew up") };
            }),
          ).pipe(Layer.provide(ServerSettings.layerTest({}))),
        ),
      ),
    ),
  ),
);

it("derives the origin a comparison uses", () => {
  const origin = UsageAttemptStamps.originOf;
  assert.strictEqual(origin({ createdBy: "user", creationSource: "web" }), "user");
  assert.strictEqual(origin({ createdBy: "agent", creationSource: "mcp" }), "agent");
  assert.strictEqual(origin({ createdBy: "agent", creationSource: "server" }), "server_dispatched");
  assert.strictEqual(
    origin({ createdBy: "system", creationSource: "provider" }),
    "server_dispatched",
  );
  assert.strictEqual(
    origin({
      createdBy: "user",
      creationSource: "server",
      scheduledTaskId: ScheduledTaskId.make("t"),
    }),
    "scheduled",
  );
});
