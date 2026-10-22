import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectFactId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type ProjectKnowledgeMutation,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as KnowledgeHandlers from "../../mcp/toolkits/knowledge/handlers.ts";
import { KnowledgeToolkit } from "../../mcp/toolkits/knowledge/tools.ts";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectKnowledge from "./ProjectKnowledge.ts";

const environmentId = EnvironmentId.make("knowledge-test-environment");
const layerTest = ProjectKnowledge.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer, ThreadSearch.layer)),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
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
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: { readonly archivedAt?: DateTime.Utc; readonly deletedAt?: DateTime.Utc } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
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
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

const message = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: { readonly minute?: number; readonly streaming?: boolean } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at(options.minute ?? 1),
  payload: {
    createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider",
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: options.streaming ?? false,
    createdAt: at(options.minute ?? 1),
    updatedAt: at(options.minute ?? 1),
  },
});

const createFact = (projectId: ProjectId, id = "fact-one") =>
  ({
    action: "create",
    commandId: CommandId.make(`create:${id}`),
    projectId,
    factId: ProjectFactId.make(id),
    content: "Cache keys include tenant IDs.",
    entities: ["cache", "tenant"],
    tags: ["isolation"],
    kind: "decision",
    sources: [{ kind: "user" }],
  }) satisfies ProjectKnowledgeMutation;

it.effect("persists edits with CAS, erases forgotten content and cannot resurrect on retries", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("facts");
    yield* createProject(projectId);
    const command = createFact(projectId);
    const saved = yield* knowledge.mutate(command, "user");
    assert.equal(saved.revision, 1);
    assert.equal(saved.status, "confirmed");
    assert.deepEqual((yield* knowledge.list({ projectId })).facts, [saved]);
    const edits = yield* Effect.all(
      ["region", "account"].map((entity) =>
        knowledge
          .mutate(
            {
              action: "edit",
              commandId: CommandId.make(`edit:${entity}`),
              projectId,
              factId: saved.id,
              expectedRevision: 1,
              content: `Cache keys include ${entity} IDs.`,
              entities: [entity],
              tags: [],
              kind: "decision",
              sources: [{ kind: "user" }],
            },
            "user",
          )
          .pipe(Effect.result),
      ),
      { concurrency: "unbounded" },
    );
    assert.equal(edits.filter(Result.isSuccess).length, 1);
    const rejection = edits.find(Result.isFailure);
    assert.equal(rejection?.failure.reason, "conflict");
    const current = (yield* knowledge.list({ projectId })).facts[0]!;
    const forgotten = yield* knowledge.mutate(
      {
        action: "forget",
        commandId: CommandId.make("forget"),
        projectId,
        factId: current.id,
        expectedRevision: 2,
      },
      "user",
    );
    assert.equal(forgotten.status, "forgotten");
    assert.equal(forgotten.content, null);
    assert.deepEqual(forgotten.sources, []);
    assert.deepEqual(forgotten.entities, []);
    assert.deepEqual(forgotten.tags, []);
    assert.deepEqual((yield* knowledge.list({ projectId })).facts, []);
    assert.deepEqual(yield* knowledge.mutate(command, "user"), forgotten);
    const recreate = yield* knowledge
      .mutate({ ...command, commandId: CommandId.make("recreate") }, "user")
      .pipe(Effect.result);
    assert.equal(Result.isFailure(recreate) && recreate.failure.reason, "forgotten");
    const fts =
      yield* sql`SELECT rowid FROM project_knowledge_fts WHERE project_knowledge_fts MATCH 'cache OR region OR account'`;
    assert.deepEqual(fts, []);
    const stored = yield* sql<{
      content: string | null;
      entities_json: string;
      tags_json: string;
      sources_json: string;
    }>`SELECT content, entities_json, tags_json, sources_json FROM project_knowledge_facts`;
    assert.deepEqual(stored, [
      { content: null, entities_json: "[]", tags_json: "[]", sources_json: "[]" },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("requires user confirmation and rehydrates exact sources before context delivery", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = ProjectId.make("sourced");
    const threadId = ThreadId.make("source-thread");
    const messageId = MessageId.make("source-message");
    yield* createProject(projectId);
    yield* projections.apply(thread(threadId, projectId));
    yield* projections.apply(
      message(threadId, messageId, "user", "Use tenant IDs in every cache key."),
    );
    const recalled = yield* knowledge.search({
      projectId,
      query: "tenant IDs",
      requestId: CommandId.make("recall-source"),
    });
    assert.equal(recalled.messages.matches[0]?.messageId, messageId);
    const source = yield* knowledge.readSource({
      projectId,
      threadId,
      messageId,
      ...(recalled.messages.matches[0]?.digest === undefined
        ? {}
        : { digest: recalled.messages.matches[0].digest }),
    });
    assert.equal(source.state, "available");
    if (source.state !== "available") return;
    const proposed = yield* knowledge.mutate(
      { ...createFact(projectId), sources: [source.source] },
      "agent",
    );
    assert.equal(proposed.status, "proposed");
    assert.deepEqual((yield* knowledge.list({ projectId })).facts, []);
    const context = {
      environmentId,
      projectId,
      selections: [{ kind: "fact" as const, factId: proposed.id, revision: 1 }],
      maxBytes: 4096,
    };
    const unconfirmed = yield* knowledge.prepareContext(context).pipe(Effect.result);
    assert.equal(Result.isFailure(unconfirmed) && unconfirmed.failure.reason, "stale_context");
    const confirm = {
      action: "confirm" as const,
      commandId: CommandId.make("confirm"),
      projectId,
      factId: proposed.id,
      expectedRevision: 1,
    };
    const forbidden = yield* knowledge.mutate(confirm, "agent").pipe(Effect.result);
    assert.equal(
      Result.isFailure(forbidden) && forbidden.failure.reason,
      "user_confirmation_required",
    );
    const confirmed = yield* knowledge.mutate(confirm, "user");
    const preview = yield* knowledge.prepareContext({
      ...context,
      selections: [{ kind: "fact", factId: confirmed.id, revision: confirmed.revision }],
    });
    assert.include(preview.text, "Cache keys include tenant IDs.");
    assert.include(preview.text, `Message ${threadId}/${messageId}`);
    assert.equal(preview.byteLength, Buffer.byteLength(preview.text));
    assert.deepEqual(yield* knowledge.resolveForTurn(preview.context), preview);
    yield* projections.apply(
      message(threadId, messageId, "user", "Use tenant IDs and regions.", { minute: 4 }),
    );
    const staleSource = yield* knowledge.readSource({ projectId, ...source.source });
    assert.deepEqual(staleSource, { state: "unavailable", reason: "changed" });
    const stale = yield* knowledge.resolveForTurn(preview.context).pipe(Effect.result);
    assert.equal(Result.isFailure(stale) && stale.failure.reason, "stale_context");
    const records = yield* projections.getThreadRecords(threadId, []);
    yield* projections.apply({
      id: EventId.make("delete-source"),
      threadId,
      type: "thread.deleted",
      occurredAt: at(5),
      payload: { ...records.thread, deletedAt: at(5) },
    });
    assert.deepEqual(yield* knowledge.readSource({ projectId, threadId, messageId }), {
      state: "unavailable",
      reason: "deleted",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "isolates projects and environments, honors archives and bounds UTF-8 context bytes",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projectId = ProjectId.make("scope-a");
      const other = ProjectId.make("scope-b");
      yield* createProject(projectId);
      yield* createProject(other);
      const threadId = ThreadId.make("archive-thread");
      const messageId = MessageId.make("archive-message");
      yield* projections.apply(thread(threadId, projectId, { archivedAt: at(2) }));
      yield* projections.apply(message(threadId, messageId, "assistant", "界".repeat(200)));
      assert.deepEqual(yield* knowledge.readSource({ projectId: other, threadId, messageId }), {
        state: "unavailable",
        reason: "wrong_project",
      });
      assert.deepEqual(yield* knowledge.readSource({ projectId, threadId, messageId }), {
        state: "unavailable",
        reason: "archived",
      });
      const source = yield* knowledge.readSource({
        projectId,
        threadId,
        messageId,
        includeArchived: true,
      });
      if (source.state !== "available")
        return assert.fail("Archived message must be readable explicitly");
      const context = {
        environmentId,
        projectId,
        selections: [source.source],
        includeArchived: true,
        maxBytes: 48000,
      };
      const preview = yield* knowledge.prepareContext(context);
      assert.isAbove(preview.byteLength, preview.text.length);
      const budget = yield* knowledge
        .prepareContext({ ...context, maxBytes: preview.byteLength - 1 })
        .pipe(Effect.result);
      assert.equal(Result.isFailure(budget) && budget.failure.reason, "context_budget");
      const wrongEnvironment = yield* knowledge
        .resolveForTurn({ ...context, environmentId: EnvironmentId.make("other") })
        .pipe(Effect.result);
      assert.equal(
        Result.isFailure(wrongEnvironment) && wrongEnvironment.failure.reason,
        "wrong_environment",
      );
      const fact = yield* knowledge.mutate(createFact(projectId), "user");
      assert.deepEqual((yield* knowledge.list({ projectId: other })).facts, []);
      const feedback = {
        action: "feedback" as const,
        commandId: CommandId.make("helpful"),
        projectId,
        factId: fact.id,
        expectedRevision: 1,
        helpful: true,
      };
      const boosted = yield* knowledge.mutate(feedback, "user");
      assert.equal(boosted.trust, 0.55);
      assert.deepEqual(yield* knowledge.mutate(feedback, "user"), boosted);
      const reuse = yield* knowledge
        .mutate({ ...feedback, helpful: false }, "user")
        .pipe(Effect.result);
      assert.equal(Result.isFailure(reuse) && reuse.failure.reason, "command_reused");
      const agentAssertion = yield* knowledge
        .mutate(createFact(projectId, "agent-assertion"), "agent")
        .pipe(Effect.result);
      assert.equal(
        Result.isFailure(agentAssertion) && agentAssertion.failure.reason,
        "invalid_source",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("MCP rejects unauthorized mutations and cannot confirm its own proposals", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = ProjectId.make("mcp-project");
    const threadId = ThreadId.make("mcp-source");
    const messageId = MessageId.make("mcp-message");
    yield* createProject(projectId);
    yield* projections.apply(thread(threadId, projectId));
    yield* projections.apply(
      message(threadId, messageId, "user", "Project cache requires tenant isolation."),
    );
    const source = yield* knowledge.readSource({ projectId, threadId, messageId });
    if (source.state !== "available") return assert.fail("Expected canonical source");
    const proposal = { ...createFact(projectId), sources: [source.source] };
    const invoke = Effect.fn("test.knowledgeMcp")(function* (
      input: ProjectKnowledgeMutation,
      access: "read-only" | "full-access",
      authorized = true,
    ) {
      const dependencies = Layer.mergeAll(
        Layer.succeed(ProjectKnowledge.ProjectKnowledge, knowledge),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "knowledge-test-client",
          thread: undefined,
          client: { sessionId: "test-client", label: "Test client", access },
          issuedAt: 0,
          capabilities: new Set(authorized ? ["orchestration" as const] : []),
        }),
      );
      const toolkit = yield* KnowledgeToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(KnowledgeHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const results = yield* toolkit
        .handle("t3_knowledge_mutate", input)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      return results.at(-1)?.result;
    });
    assert.deepInclude(yield* invoke(proposal, "read-only"), { code: "capability_denied" });
    assert.deepInclude(yield* invoke(proposal, "full-access", false), {
      code: "capability_denied",
    });
    assert.deepEqual((yield* knowledge.list({ projectId, status: "proposed" })).facts, []);
    assert.deepInclude(yield* invoke(proposal, "full-access"), { status: "proposed", revision: 1 });
    assert.deepInclude(
      yield* invoke(
        {
          action: "confirm",
          commandId: CommandId.make("mcp-confirm"),
          projectId,
          factId: proposal.factId,
          expectedRevision: 1,
        },
        "full-access",
      ),
      {
        code: "invalid_request",
        message: "A user must confirm proposed knowledge.",
      },
    );
    assert.deepEqual((yield* knowledge.list({ projectId })).facts, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reopens durable project facts without another content authority", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-knowledge-persistence-" });
    const layerFile = ProjectKnowledge.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer, ThreadSearch.layer),
      ),
      Layer.provideMerge(SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"))),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );
    const projectId = ProjectId.make("durable-project");
    const saved = yield* Effect.gen(function* () {
      yield* createProject(projectId);
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      return yield* knowledge.mutate(createFact(projectId), "user");
    }).pipe(Effect.provide(layerFile));
    const reopened = yield* Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      return yield* knowledge.list({ projectId });
    }).pipe(Effect.provide(layerFile));
    assert.deepEqual(reopened.facts, [saved]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
