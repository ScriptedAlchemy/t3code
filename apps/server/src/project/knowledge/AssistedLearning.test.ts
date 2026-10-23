import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectFactId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  TextGenerationError,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as AssistedLearning from "./AssistedLearning.ts";
import { AssistedLearningRunner, assistedLearningEffects } from "./assistedLearningSchedule.ts";
import * as HolographicMemory from "./HolographicMemory.ts";
import * as ProjectKnowledge from "./ProjectKnowledge.ts";

type Generate = TextGeneration.TextGeneration["Service"]["generateKnowledgeCandidates"];

const projectId = ProjectId.make("learning");
const threadId = ThreadId.make("learning-thread");
const runId = RunId.make("learning-run");
const providerInstanceId = ProviderInstanceId.make("codex");
const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 1));
const optedIn = { projectSettingsOverrides: { [projectId]: { enableAssistedLearning: true } } };

const makeLayer = (generate: Generate, settings: Parameters<typeof ServerSettings.layerTest>[0]) =>
  AssistedLearning.layerRunner.pipe(
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({ generateKnowledgeCandidates: generate }),
    ),
    Layer.provideMerge(ProjectKnowledge.layer.pipe(Layer.provide(HolographicMemory.layer))),
    Layer.provideMerge(
      Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer, ThreadSearch.layer),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSettings.layerTest(settings)),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("learning-environment")),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** A text generation double that records each call and replies from a script. */
const scripted = (
  replies: ReadonlyArray<TextGeneration.KnowledgeCandidatesGenerationResult | TextGenerationError>,
) => {
  const calls: Array<Parameters<Generate>[0]> = [];
  const generate: Generate = (input) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)]!;
    calls.push(input);
    return Schema.is(TextGenerationError)(reply) ? Effect.fail(reply) : Effect.succeed(reply);
  };
  return { calls, generate };
};

const seedRun = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* projects.apply({
    sequence: 0,
    eventId: EventId.make(`created:${projectId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: DateTime.formatIso(at),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: projectId,
      workspaceRoot: `/work/${projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: DateTime.formatIso(at),
      updatedAt: DateTime.formatIso(at),
    },
  });
  const thread: OrchestrationV2DomainEvent = {
    id: EventId.make(`created:${threadId}`),
    type: "thread.created",
    threadId,
    providerInstanceId,
    occurredAt: at,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: threadId,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
  yield* projections.apply(thread);
  const messages = [
    ["learning-user", "user", "From now on API responses use snake_case keys everywhere."],
    ["learning-reply", "assistant", "Done. I converted the handlers to snake_case keys."],
  ] as const;
  for (const [index, [id, role, text]] of messages.entries()) {
    const createdAt = DateTime.add(at, { minutes: index + 1 });
    yield* projections.apply({
      id: EventId.make(`message:${id}`),
      type: "message.updated",
      threadId,
      providerInstanceId,
      occurredAt: createdAt,
      payload: {
        createdBy: role === "user" ? "user" : "agent",
        creationSource: role === "user" ? "web" : "provider",
        id: MessageId.make(id),
        threadId,
        runId,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      },
    });
  }
});

const sha256 = (text: string) =>
  Effect.flatMap(Crypto.Crypto, (crypto) =>
    crypto.digest("SHA-256", new TextEncoder().encode(text)),
  ).pipe(Effect.map(Hex.encode));

const snakeCase = {
  kind: "convention" as const,
  content: "API responses use snake_case keys.",
  entities: ["api"],
  citations: ["M1", "M2"],
};

it("schedules one coalesced job per run only for opted-in projects", () => {
  const input = { projectId, threadId, runId, status: "completed" as const };
  assert.deepEqual(assistedLearningEffects({ ...input, settings: DEFAULT_SERVER_SETTINGS }), []);
  const otherProject = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: { [ProjectId.make("other")]: { enableAssistedLearning: true } },
  };
  assert.deepEqual(assistedLearningEffects({ ...input, settings: otherProject }), []);
  const settings = { ...DEFAULT_SERVER_SETTINGS, ...optedIn };
  const [effect] = assistedLearningEffects({ ...input, settings });
  assert.equal(effect?.id, `effect:project-knowledge.extract:${runId}`);
  assert.deepEqual(effect?.request, {
    type: "project-knowledge.extract",
    runId,
    runOutcome: "completed",
  });
  assert.deepEqual(
    assistedLearningEffects({ ...input, status: "cancelled", settings })[0]?.request,
    { type: "project-knowledge.extract", runId, runOutcome: "interrupted" },
  );
});

it.effect("turns a settled run into cited proposals exactly once", () => {
  const model = scripted([
    { candidates: [snakeCase, { ...snakeCase, content: "Invented.", citations: ["M9"] }] },
  ]);
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    // A replayed or retried effect for the same run does not call the model again.
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    assert.equal(model.calls.length, 1);
    assert.deepEqual(
      model.calls[0]!.messages.map((message) => [message.ref, message.role]),
      [
        ["M1", "user"],
        ["M2", "assistant"],
      ],
    );
    const { facts } = yield* knowledge.list({ projectId, status: "proposed", origin: "assisted" });
    assert.equal(facts.length, 1);
    const fact = facts[0]!;
    assert.equal(fact.status, "proposed");
    assert.equal(fact.content, snakeCase.content);
    assert.deepEqual(fact.origin, { kind: "assisted", threadId, runId, runOutcome: "completed" });
    assert.deepEqual(fact.sources, [
      {
        kind: "message",
        threadId,
        messageId: MessageId.make("learning-user"),
        digest: yield* sha256("From now on API responses use snake_case keys everywhere."),
      },
      {
        kind: "message",
        threadId,
        messageId: MessageId.make("learning-reply"),
        digest: yield* sha256("Done. I converted the handlers to snake_case keys."),
      },
    ]);
    const status = yield* knowledge.status({ projectId });
    assert.equal(status.assistedLearning?.suggested, 1);
    assert.deepEqual(
      status.assistedLearning?.lastRun && {
        result: status.assistedLearning.lastRun.result,
        proposed: status.assistedLearning.lastRun.proposed,
        reason: status.assistedLearning.lastRun.reason,
      },
      { result: "ran", proposed: 1, reason: "1 candidate dropped: citations did not verify." },
    );
    // Unreviewed model text stays out of agent recall.
    const recalled = yield* knowledge.search({
      projectId,
      query: "snake_case API responses",
      requestId: CommandId.make("learning-search"),
    });
    assert.deepEqual(
      recalled.facts.state === "available" ? recalled.facts.matches.map((m) => m.fact.id) : [],
      [],
    );
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("marks candidates from a failed run with that outcome", () => {
  const model = scripted([{ candidates: [snakeCase] }]);
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    yield* runner.extractRun({ threadId, runId, runOutcome: "failed" });
    assert.equal(model.calls[0]!.runOutcome, "failed");
    const { facts } = yield* knowledge.list({ projectId, status: "proposed" });
    assert.deepEqual(
      facts.map((fact) => [fact.status, fact.origin.kind === "assisted" && fact.origin.runOutcome]),
      [["proposed", "failed"]],
    );
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("suggests replacing a near duplicate instead of duplicating it", () => {
  const model = scripted([
    {
      candidates: [
        { ...snakeCase, content: "API responses use snake_case keys for every public endpoint." },
        { ...snakeCase, content: "Tests run with vp test." },
      ],
    },
  ]);
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const existing = yield* knowledge.mutate(
      {
        action: "create",
        commandId: CommandId.make("existing"),
        projectId,
        factId: ProjectFactId.make("existing"),
        content: "API responses use snake_case keys for every endpoint.",
        entities: [],
        tags: [],
        kind: "convention",
        sources: [{ kind: "user" }],
      },
      { kind: "user" },
    );
    yield* knowledge.mutate(
      {
        action: "create",
        commandId: CommandId.make("exact"),
        projectId,
        factId: ProjectFactId.make("exact"),
        content: "Tests run with vp test.",
        entities: [],
        tags: [],
        kind: "convention",
        sources: [{ kind: "user" }],
      },
      { kind: "user" },
    );
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    const { facts } = yield* knowledge.list({ projectId, status: "proposed", origin: "assisted" });
    // The exact duplicate created nothing; the near duplicate names what it would replace.
    assert.deepEqual(
      facts.map((fact) => [fact.id, fact.supersedes]),
      [[ProjectFactId.make(`assisted:${runId}:0`), existing.id]],
    );
    assert.equal((yield* knowledge.status({ projectId })).assistedLearning?.lastRun?.suggested, 1);
    // The existing fact stays recalled until a user accepts the replacement.
    const before = (yield* knowledge.readFact({ projectId, factId: existing.id })).fact;
    assert.equal(before.supersededBy ?? null, null);
    const suggestion = facts[0]!;
    yield* knowledge.mutate(
      {
        action: "confirm",
        commandId: CommandId.make("accept"),
        projectId,
        factId: suggestion.id,
        expectedRevision: suggestion.revision,
      },
      { kind: "user" },
    );
    const after = (yield* knowledge.readFact({ projectId, factId: existing.id })).fact;
    assert.equal(after.supersededBy, suggestion.id);
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("does not bring back a forgotten proposal when the job runs again", () => {
  const model = scripted([{ candidates: [snakeCase] }]);
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    const [proposal] = (yield* knowledge.list({ projectId, status: "proposed" })).facts;
    yield* knowledge.mutate(
      {
        action: "forget",
        commandId: CommandId.make("forget-proposal"),
        projectId,
        factId: proposal!.id,
        expectedRevision: proposal!.revision,
      },
      { kind: "user" },
    );
    // A job lost before it recorded its outcome reruns and gets the same reply.
    yield* sql`DELETE FROM project_knowledge_assisted_runs`;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    assert.equal(model.calls.length, 2);
    assert.deepEqual((yield* knowledge.list({ projectId, status: "proposed" })).facts, []);
    assert.deepEqual(
      (yield* knowledge.list({ projectId, status: "forgotten" })).facts.map((fact) => fact.id),
      [proposal!.id],
    );
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("records skipped and failed outcomes without proposing anything", () => {
  const failing = scripted([
    new TextGenerationError({ operation: "generateKnowledgeCandidates", detail: "Rate limited." }),
  ]);
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    const lastRun = (yield* knowledge.status({ projectId })).assistedLearning?.lastRun;
    assert.deepEqual([lastRun?.result, lastRun?.reason], ["failed", "Rate limited."]);
    assert.deepEqual((yield* knowledge.list({ projectId, status: "proposed" })).facts, []);
  }).pipe(Effect.provide(makeLayer(failing.generate, optedIn)));
});

it.effect("skips a run whose project turned assisted learning off before it ran", () => {
  const model = scripted([{ candidates: [snakeCase] }]);
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    assert.equal(model.calls.length, 0);
    assert.equal(
      (yield* knowledge.status({ projectId })).assistedLearning?.lastRun?.result,
      "skipped",
    );
  }).pipe(Effect.provide(makeLayer(model.generate, {})));
});
