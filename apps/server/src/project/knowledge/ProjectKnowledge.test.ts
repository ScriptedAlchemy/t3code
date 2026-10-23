import * as HolographicMemory from "./HolographicMemory.ts";
import { resolveKnowledgeComposer } from "./composer.ts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { assert, it } from "@effect/vitest";
import {
  ComposerContextId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectFactId,
  ProjectKnowledgeSearchResult,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type ProjectKnowledgeMutation,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
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
const knowledgeTestLayer = (scoring: typeof HolographicMemory.layer = HolographicMemory.layer) =>
  ProjectKnowledge.layer.pipe(
    Layer.provide(scoring),
    Layer.provideMerge(
      Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer, ThreadSearch.layer),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

const layerTest = knowledgeTestLayer();

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
    const saved = yield* knowledge.mutate(command, { kind: "user" });
    assert.equal(saved.revision, 1);
    assert.equal(saved.status, "confirmed");
    const oversized = yield* knowledge
      .mutate(
        { ...createFact(projectId, "oversized"), content: "測".repeat(6000) },
        { kind: "user" },
      )
      .pipe(Effect.result);
    assert.equal(Result.isFailure(oversized) && oversized.failure.reason, "fact_size");
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
            { kind: "user" },
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
      { kind: "user" },
    );
    assert.equal(forgotten.status, "forgotten");
    assert.equal(forgotten.content, null);
    assert.deepEqual(forgotten.sources, []);
    assert.deepEqual(forgotten.entities, []);
    assert.deepEqual(forgotten.tags, []);
    assert.deepEqual((yield* knowledge.list({ projectId })).facts, []);
    assert.deepEqual(yield* knowledge.mutate(command, { kind: "user" }), forgotten);
    const recreate = yield* knowledge
      .mutate({ ...command, commandId: CommandId.make("recreate") }, { kind: "user" })
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

it.effect(
  "recalls agent proposals before optional human confirmation and rehydrates exact sources",
  () =>
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
        { kind: "agent-client", sessionId: "test-agent", label: "Test agent" },
      );
      assert.equal(proposed.status, "proposed");
      assert.deepEqual((yield* knowledge.list({ projectId })).facts, []);
      const context = {
        environmentId,
        projectId,
        selections: [{ kind: "fact" as const, factId: proposed.id, revision: 1 }],
        maxBytes: 4096,
      };
      const unconfirmed = yield* knowledge.prepareContext(context);
      assert.include(unconfirmed.text, "status:proposed");
      const confirm = {
        action: "confirm" as const,
        commandId: CommandId.make("confirm"),
        projectId,
        factId: proposed.id,
        expectedRevision: 1,
      };
      const forbidden = yield* knowledge
        .mutate(confirm, { kind: "agent-client", sessionId: "test-agent", label: "Test agent" })
        .pipe(Effect.result);
      assert.equal(
        Result.isFailure(forbidden) && forbidden.failure.reason,
        "user_confirmation_required",
      );
      const confirmed = yield* knowledge.mutate(confirm, { kind: "user" });
      const preview = yield* knowledge.prepareContext({
        ...context,
        selections: [{ kind: "fact", factId: confirmed.id, revision: confirmed.revision }],
      });
      assert.include(preview.text, "Cache keys include tenant IDs.");
      assert.include(preview.text, `Message ${threadId}/${messageId}`);
      assert.isAtLeast(preview.byteLength, Buffer.byteLength(preview.text));
      assert.include(
        (yield* knowledge.resolveForTurn(preview.context)).text,
        "Cache keys include tenant IDs.",
      );
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

it.effect("lists which facts cite sources that were edited, deleted or archived", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = ProjectId.make("badges");
    yield* createProject(projectId);
    const cite = Effect.fn("test.cite")(function* (key: string) {
      const threadId = ThreadId.make(`${key}-thread`);
      const messageId = MessageId.make(`${key}-message`);
      yield* projections.apply(thread(threadId, projectId));
      yield* projections.apply(message(threadId, messageId, "assistant", `${key} decision`));
      const source = yield* knowledge.readSource({ projectId, threadId, messageId });
      assert.equal(source.state, "available");
      if (source.state !== "available") return yield* Effect.die("source unavailable");
      yield* knowledge.mutate(
        {
          ...createFact(projectId, key),
          commandId: CommandId.make(`create:${key}`),
          sources: [source.source],
        },
        { kind: "user" },
      );
      return { threadId, messageId };
    });
    yield* cite("intact");
    const edited = yield* cite("edited");
    const deleted = yield* cite("deleted");
    const archived = yield* cite("archived");
    yield* knowledge.mutate(createFact(projectId, "asserted"), { kind: "user" });

    yield* projections.apply(
      message(edited.threadId, edited.messageId, "assistant", "edited later", { minute: 3 }),
    );
    const deletedThread = yield* projections.getThreadRecords(deleted.threadId, []);
    yield* projections.apply({
      id: EventId.make("delete-badge-source"),
      threadId: deleted.threadId,
      type: "thread.deleted",
      occurredAt: at(4),
      payload: { ...deletedThread.thread, deletedAt: at(4) },
    });
    const archivedThread = yield* projections.getThreadRecords(archived.threadId, []);
    yield* projections.apply({
      id: EventId.make("archive-badge-source"),
      threadId: archived.threadId,
      type: "thread.archived",
      occurredAt: at(5),
      payload: { ...archivedThread.thread, archivedAt: at(5) },
    });

    const listed = yield* knowledge.list({ projectId });
    assert.equal(listed.facts.length, 5);
    assert.sameDeepMembers(
      [...(listed.unavailableSources ?? [])],
      [
        { factId: ProjectFactId.make("edited"), reason: "changed" },
        { factId: ProjectFactId.make("deleted"), reason: "deleted" },
        { factId: ProjectFactId.make("archived"), reason: "archived" },
      ],
    );
    // The badge must agree with what opening the citation reports.
    for (const [key, ref, reason] of [
      ["edited", edited, "changed"],
      ["deleted", deleted, "deleted"],
      ["archived", archived, "archived"],
    ] as const) {
      const source = listed.facts.find((item) => item.id === key)?.sources[0];
      assert.equal(source?.kind, "message");
      if (source?.kind !== "message") continue;
      assert.deepEqual(yield* knowledge.readSource({ projectId, ...ref, digest: source.digest }), {
        state: "unavailable",
        reason,
      });
    }
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
      const fact = yield* knowledge.mutate(createFact(projectId), { kind: "user" });
      assert.deepEqual((yield* knowledge.list({ projectId: other })).facts, []);
      const feedback = {
        action: "feedback" as const,
        commandId: CommandId.make("helpful"),
        projectId,
        factId: fact.id,
        expectedRevision: 1,
        helpful: true,
      };
      const boosted = yield* knowledge.mutate(feedback, { kind: "user" });
      assert.equal(boosted.trust, 0.55);
      assert.deepEqual(yield* knowledge.mutate(feedback, { kind: "user" }), boosted);
      const reuse = yield* knowledge
        .mutate({ ...feedback, helpful: false }, { kind: "user" })
        .pipe(Effect.result);
      assert.equal(Result.isFailure(reuse) && reuse.failure.reason, "command_reused");
      const agentAssertion = yield* knowledge
        .mutate(createFact(projectId, "agent-assertion"), {
          kind: "agent-client",
          sessionId: "test-agent",
          label: "Test agent",
        })
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
        .handle("t3_knowledge_mutate", { mutation: input })
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
    const observation = { ...createFact(projectId, "agent-observation"), sources: [] };
    const created = yield* invoke(observation, "full-access");
    assert.deepInclude(created, {
      status: "proposed",
      origin: { kind: "agent-client", sessionId: "test-client", label: "Test client" },
      sources: [],
    });
    const recalled = yield* knowledge.search({
      projectId,
      query: "tenant cache",
      requestId: CommandId.make("agent-observation-recall"),
    });
    assert.isTrue(
      recalled.facts.state === "available" &&
        recalled.facts.matches.some(
          (match) => match.fact.id === observation.factId && match.fact.status === "proposed",
        ),
    );
    const edited = yield* invoke(
      {
        ...observation,
        action: "edit",
        commandId: CommandId.make("edit-observation"),
        expectedRevision: 1,
        content: "Tenant cache observations are scoped.",
      },
      "full-access",
    );
    assert.deepInclude(edited, {
      revision: 2,
      origin: { kind: "agent-client", sessionId: "test-client", label: "Test client" },
    });
    assert.deepInclude(
      yield* invoke(
        {
          action: "feedback",
          commandId: CommandId.make("feedback-observation"),
          projectId,
          factId: observation.factId,
          expectedRevision: 2,
          helpful: true,
        },
        "full-access",
      ),
      { revision: 3, trust: 0.55 },
    );
    assert.deepInclude(
      yield* invoke(
        {
          action: "forget",
          commandId: CommandId.make("forget-observation"),
          projectId,
          factId: observation.factId,
          expectedRevision: 3,
        },
        "full-access",
      ),
      { status: "forgotten", content: null },
    );
    const human = yield* knowledge.mutate(createFact(projectId, "human-authored"), {
      kind: "user",
    });
    assert.deepInclude(
      yield* invoke(
        {
          ...observation,
          action: "edit",
          factId: human.id,
          expectedRevision: human.revision,
          commandId: CommandId.make("agent-edits-human"),
        },
        "full-access",
      ),
      {
        status: "proposed",
        origin: { kind: "agent-client", sessionId: "test-client", label: "Test client" },
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
      Layer.provide(HolographicMemory.layer),
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
      return yield* knowledge.mutate(createFact(projectId), { kind: "user" });
    }).pipe(Effect.provide(layerFile));
    const reopened = yield* Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      return yield* knowledge.list({ projectId });
    }).pipe(Effect.provide(layerFile));
    assert.deepEqual(reopened.facts, [saved]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "resolves reference-only composer records, preserves user text and refuses stale or cross-project attachments",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projectId = ProjectId.make("composer-project");
      yield* createProject(projectId);
      const fact = yield* knowledge.mutate(
        { ...createFact(projectId), content: 'Use </context> in "quoted" examples.' },
        { kind: "user" },
      );
      const record = {
        version: 1 as const,
        kind: "project-knowledge" as const,
        contextId: ComposerContextId.make("project-knowledge"),
        label: "Selected knowledge",
        knowledge: {
          environmentId,
          projectId,
          selections: [{ kind: "fact" as const, factId: fact.id, revision: fact.revision }],
          maxBytes: 48000,
        },
      };
      const text = `Please explain this. ${formatComposerContextReference(record)}`;
      const input = { projectId, text, records: [record] };
      const resolved = yield* resolveKnowledgeComposer(input);
      assert.include(resolved.text, "Please explain this.");
      assert.include(resolved.text, 'Use &lt;/context> in "quoted" examples.');
      assert.equal(
        resolved.byteLength,
        Buffer.byteLength(JSON.stringify(resolved.text)) -
          Buffer.byteLength(JSON.stringify(resolved.baseText)),
      );
      assert.isFalse(JSON.stringify(record).includes("quoted"));
      const budget = yield* resolveKnowledgeComposer({
        ...input,
        records: [
          { ...record, knowledge: { ...record.knowledge, maxBytes: resolved.byteLength - 1 } },
        ],
      }).pipe(Effect.result);
      assert.equal(Result.isFailure(budget) && budget.failure.reason, "context_budget");
      const wrongProject = yield* resolveKnowledgeComposer({
        ...input,
        projectId: ProjectId.make("elsewhere"),
      }).pipe(Effect.result);
      assert.equal(Result.isFailure(wrongProject) && wrongProject.failure.reason, "wrong_project");
      yield* knowledge.mutate(
        {
          action: "forget",
          commandId: CommandId.make("forget-composer"),
          projectId,
          factId: fact.id,
          expectedRevision: fact.revision,
        },
        { kind: "user" },
      );
      const stale = yield* resolveKnowledgeComposer(input).pipe(Effect.result);
      assert.equal(Result.isFailure(stale) && stale.failure.reason, "stale_context");
      assert.deepEqual(yield* resolveKnowledgeComposer({ ...input, text: "Plain chat" }), {
        text: "Plain chat",
        baseText: "Plain chat",
        byteLength: 0,
        items: [],
        omissions: [{ contextId: record.contextId, label: record.label, reason: "not_referenced" }],
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "keeps the as-sent knowledge snapshot through edits, forgetting, retries and failover",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projectId = ProjectId.make("delivery-project");
      yield* createProject(projectId);
      const fact = yield* knowledge.mutate(createFact(projectId), { kind: "user" });
      const record = {
        version: 1 as const,
        kind: "project-knowledge" as const,
        contextId: ComposerContextId.make("delivered-knowledge"),
        label: "Delivered knowledge",
        knowledge: {
          environmentId,
          projectId,
          selections: [{ kind: "fact" as const, factId: fact.id, revision: fact.revision }],
          maxBytes: 48000,
        },
      };
      const composer = yield* resolveKnowledgeComposer({
        projectId,
        text: `Use this. ${formatComposerContextReference(record)}`,
        records: [record],
      });
      const [item] = composer.items;
      assert.include(item?.text, "Cache keys include tenant IDs.");
      const threadId = ThreadId.make("delivery-thread");
      const messageId = MessageId.make("delivery-message");
      const delivery = (attemptId: string, status: "prepared" | "sent", minute: number) => ({
        attemptId: RunAttemptId.make(attemptId),
        runId: RunId.make("delivery-run"),
        threadId,
        messageId,
        projectId,
        providerInstanceId,
        status,
        items: composer.items,
        omissions: composer.omissions,
        createdAt: DateTime.formatIso(at(minute)),
        updatedAt: DateTime.formatIso(at(minute)),
      });
      const read = knowledge.readDeliveries({ projectId, threadId, messageId });
      yield* knowledge.recordDelivery(delivery("attempt-1", "prepared", 1));
      yield* knowledge.recordDelivery(delivery("attempt-1", "sent", 2));
      const sent = yield* read;
      assert.deepEqual(
        sent.deliveries.map((entry) => [entry.attemptId, entry.status, entry.createdAt]),
        [["attempt-1", "sent", DateTime.formatIso(at(1))]],
      );
      assert.deepEqual(sent.deliveries[0]?.items, [{ ...item!, current: "current" }]);

      yield* knowledge.mutate(
        {
          ...createFact(projectId),
          action: "edit",
          commandId: CommandId.make("edit-after-send"),
          expectedRevision: fact.revision,
          content: "Cache keys include region IDs.",
        },
        { kind: "user" },
      );
      // Re-preparing a sent attempt must neither duplicate nor rewrite what was sent.
      yield* knowledge.recordDelivery({
        ...delivery("attempt-1", "prepared", 3),
        items: [{ ...item!, text: "rewritten" }],
      });
      const edited = yield* read;
      assert.equal(edited.deliveries.length, 1);
      assert.equal(edited.deliveries[0]?.status, "sent");
      assert.equal(edited.deliveries[0]?.items[0]?.text, item?.text);
      assert.equal(edited.deliveries[0]?.items[0]?.current, "changed");

      yield* knowledge.recordDelivery(delivery("attempt-failover", "sent", 4));
      yield* knowledge.mutate(
        {
          action: "forget",
          commandId: CommandId.make("forget-after-send"),
          projectId,
          factId: fact.id,
          expectedRevision: fact.revision + 1,
        },
        { kind: "user" },
      );
      const forgotten = yield* read;
      assert.deepEqual(
        forgotten.deliveries.map((entry) => [
          entry.attemptId,
          entry.items[0]?.text,
          entry.items[0]?.current,
        ]),
        [
          ["attempt-1", item?.text, "forgotten"],
          ["attempt-failover", item?.text, "forgotten"],
        ],
      );
      const otherProjectId = ProjectId.make("other-delivery-project");
      yield* createProject(otherProjectId);
      assert.deepEqual(
        yield* knowledge.readDeliveries({ projectId: otherProjectId, threadId, messageId }),
        { deliveries: [] },
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "MCP ranks canonical project facts through the native addon and records retrieval once",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projectId = ProjectId.make("native-mcp");
      const other = ProjectId.make("other-native-project");
      yield* createProject(projectId);
      yield* createProject(other);
      for (const id of ["b", "a", "c"])
        yield* knowledge.mutate(createFact(projectId, id), { kind: "user" });
      yield* knowledge.mutate(
        {
          ...createFact(projectId, "irrelevant"),
          content: "Use a small font.",
          entities: [],
          tags: [],
        },
        { kind: "user" },
      );
      yield* knowledge.mutate(createFact(other, "foreign"), { kind: "user" });
      const dependencies = Layer.mergeAll(
        Layer.succeed(ProjectKnowledge.ProjectKnowledge, knowledge),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "native-mcp",
          thread: undefined,
          client: { sessionId: "agent", label: "Agent", access: "read-only" },
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
      );
      const toolkit = yield* KnowledgeToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(KnowledgeHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const query = {
        projectId,
        query: "tenant cache",
        requestId: CommandId.make("native-search"),
        limit: 1,
      };
      const results = yield* toolkit
        .handle("t3_knowledge_search", query)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      const result = yield* Schema.decodeUnknownEffect(ProjectKnowledgeSearchResult)(
        results.at(-1)?.result,
      );
      if (result.facts.state !== "available")
        return assert.fail("Real native ranking must be available");
      assert.equal(result.facts.coverage, "complete");
      assert.equal(result.facts.matches[0]?.fact.id, "a");
      assert.isAbove(result.facts.matches[0]!.score.lexical, 0);
      assert.isAbove(result.facts.matches[0]!.score.holographic, 0);
      assert.equal(result.facts.matches[0]!.fact.retrievalCount, 1);
      const replay = yield* knowledge.search(query);
      assert.equal(
        replay.facts.state === "available" && replay.facts.matches[0]?.fact.retrievalCount,
        1,
      );
      assert.isNotNull(result.facts.nextCursor);
      const page = yield* knowledge.search({
        ...query,
        requestId: CommandId.make("native-page"),
        factCursor: result.facts.nextCursor!,
        limit: 10,
      });
      assert.deepEqual(
        page.facts.state === "available" && page.facts.matches.map((match) => match.fact.id),
        [ProjectFactId.make("b"), ProjectFactId.make("c")],
      );
      const wrongCursor = yield* knowledge
        .search({
          ...query,
          requestId: CommandId.make("wrong-cursor"),
          query: "different",
          factCursor: result.facts.nextCursor!,
        })
        .pipe(Effect.result);
      assert.equal(Result.isFailure(wrongCursor) && wrongCursor.failure.reason, "invalid_cursor");
      const reused = yield* knowledge.search({ ...query, query: "different" }).pipe(Effect.result);
      assert.equal(Result.isFailure(reused) && reused.failure.reason, "command_reused");
      const entity = yield* knowledge.search({
        ...query,
        requestId: CommandId.make("entities"),
        entities: ["TENANT", "cache"],
        entityMatch: "all",
      });
      assert.equal(entity.facts.state === "available" && entity.facts.matches.length, 1);
      yield* (yield* SqlClient.SqlClient)`UPDATE project_knowledge_facts SET trust = 0.2 WHERE id = 'a'`;
      const trust = yield* knowledge.search({
        ...query,
        requestId: CommandId.make("trust"),
        limit: 10,
      });
      assert.deepEqual(
        trust.facts.state === "available" && trust.facts.matches.map((match) => match.fact.id),
        [ProjectFactId.make("b"), ProjectFactId.make("c")],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("traverses native rankings once despite unequal retrieval reinforcement", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("unequal-reinforcement");
    yield* createProject(projectId);
    for (const id of ["a", "b", "c", "d"])
      yield* knowledge.mutate(createFact(projectId, id), { kind: "user" });
    yield* sql`UPDATE project_knowledge_facts SET retrieval_count = 100, trust = 0.46 WHERE id = 'a'`;
    const query = { projectId, query: "tenant cache", limit: 2 };
    const firstInput = { ...query, requestId: CommandId.make("unequal-first") };
    const first = yield* knowledge.search(firstInput);
    if (first.facts.state !== "available") return assert.fail("Native ranking must be available");
    assert.deepEqual(
      first.facts.matches.map(({ fact }) => fact.id),
      ["a", "b"],
    );
    assert.equal(first.facts.matches[0]!.fact.retrievalCount, 101);
    assert.equal(first.facts.matches[1]!.fact.retrievalCount, 1);
    const seen = first.facts.matches.map(({ fact }) => fact.id);
    let cursor = first.facts.nextCursor;
    for (let page = 1; cursor !== null && page < 5; page++) {
      const input = { ...query, requestId: CommandId.make(`unequal-${page}`), factCursor: cursor };
      const next = yield* knowledge.search(input);
      if (next.facts.state !== "available") return assert.fail("Native ranking must be available");
      assert.deepEqual(
        next.facts.matches.filter(({ fact }) => seen.includes(fact.id)),
        [],
      );
      seen.push(...next.facts.matches.map(({ fact }) => fact.id));
      const replay = yield* knowledge.search(input);
      assert.deepEqual(replay, next);
      cursor = next.facts.nextCursor;
    }
    assert.isNull(cursor);
    assert.deepEqual(seen, ["a", "b", "c", "d"]);
    const replay = yield* knowledge.search(firstInput);
    assert.deepEqual(replay, first);
    const counts = yield* sql<{ id: string; count: number }>`
      SELECT id, retrieval_count AS count FROM project_knowledge_facts ORDER BY id`;
    assert.deepEqual(counts, [
      { id: "a", count: 101 },
      { id: "b", count: 1 },
      { id: "c", count: 1 },
      { id: "d", count: 1 },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("pages conversations without reranking or reinforcing the current fact page", () =>
  Effect.gen(function* () {
    let scoreCalls = 0;
    const scoring = Layer.effect(
      HolographicMemory.HolographicMemory,
      Effect.gen(function* () {
        const native = yield* HolographicMemory.HolographicMemory;
        return HolographicMemory.HolographicMemory.of({
          scoreCandidates: (input) => {
            scoreCalls += 1;
            return native.scoreCandidates(input);
          },
        });
      }),
    ).pipe(Layer.provide(HolographicMemory.layer));
    yield* Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projectId = ProjectId.make("independent-paging");
      const other = ProjectId.make("other-paging");
      yield* createProject(projectId);
      yield* createProject(other);
      for (const id of ["a", "b", "c"]) {
        const threadId = ThreadId.make(`conversation-${id}`);
        yield* projections.apply(thread(threadId, projectId));
        yield* projections.apply(message(threadId, `message-${id}`, "user", "tenant cache"));
        yield* knowledge.mutate(createFact(projectId, id), { kind: "user" });
      }
      const input = {
        projectId,
        query: "tenant cache",
        limit: 1,
        requestId: CommandId.make("independent-first"),
      };
      const first = yield* knowledge.search(input);
      if (first.facts.state !== "available" || first.messages.nextCursor == null)
        return assert.fail("Both searches must have another page");
      const nextInput = { ...input, cursor: first.messages.nextCursor };
      const messages = yield* knowledge.search(nextInput);
      assert.deepEqual(messages.facts, first.facts);
      assert.notEqual(messages.messages.matches[0]?.threadId, first.messages.matches[0]?.threadId);
      const facts = yield* knowledge.search({
        ...nextInput,
        requestId: CommandId.make("independent-facts"),
        factCursor: first.facts.nextCursor!,
      });
      assert.deepEqual(facts.messages, messages.messages);
      assert.deepEqual(
        facts.facts.state === "available" && facts.facts.matches.map(({ fact }) => fact.id),
        [ProjectFactId.make("b")],
      );
      assert.equal(scoreCalls, 1);
      for (const change of [
        { query: "different" },
        { projectId: other },
        { includeArchived: true },
        { minTrust: 0.4 },
        { entities: ["tenant"] },
      ]) {
        const reused = yield* knowledge.search({ ...input, ...change }).pipe(Effect.result);
        assert.equal(Result.isFailure(reused) && reused.failure.reason, "command_reused");
        const mismatch = yield* knowledge
          .search({
            ...input,
            ...change,
            requestId: CommandId.make(`mismatch-${JSON.stringify(change)}`),
            factCursor: first.facts.nextCursor!,
          })
          .pipe(Effect.result);
        assert.equal(Result.isFailure(mismatch) && mismatch.failure.reason, "invalid_cursor");
      }
    }).pipe(Effect.provide(knowledgeTestLayer(scoring)));
  }),
);

it.effect.each(["edit", "forget", "source"] as const)(
  "omits a %s change from continuation and replay",
  (action) =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projectId = ProjectId.make(`page-${action}`);
      const threadId = ThreadId.make(`source-${action}`);
      yield* createProject(projectId);
      yield* projections.apply(thread(threadId, projectId));
      yield* projections.apply(message(threadId, "source-message", "user", "tenant cache"));
      const source = yield* knowledge.readSource({
        projectId,
        threadId,
        messageId: MessageId.make("source-message"),
      });
      if (source.state !== "available") return assert.fail("Source must be available");
      for (const id of ["a", "b", "c"])
        yield* knowledge.mutate(
          { ...createFact(projectId, id), sources: [source.source] },
          { kind: "user" },
        );
      const input = {
        projectId,
        query: "tenant cache",
        limit: 1,
        requestId: CommandId.make(`before-${action}`),
      };
      const first = yield* knowledge.search(input);
      if (first.facts.state !== "available" || !first.facts.nextCursor)
        return assert.fail("Facts must have another page");
      if (action === "source") {
        yield* projections.apply(
          message(threadId, "source-message", "user", "Changed source", { minute: 2 }),
        );
      } else {
        for (const id of ["a", "b"])
          yield* knowledge.mutate(
            action === "forget"
              ? {
                  action,
                  commandId: CommandId.make(`forget-${id}`),
                  projectId,
                  factId: ProjectFactId.make(id),
                  expectedRevision: 1,
                }
              : {
                  ...createFact(projectId, id),
                  action,
                  commandId: CommandId.make(`edit-${id}`),
                  expectedRevision: 1,
                  content: "Revised decision",
                },
            { kind: "user" },
          );
      }
      const page = yield* knowledge.search({
        ...input,
        requestId: CommandId.make(`after-${action}`),
        factCursor: first.facts.nextCursor,
      });
      assert.deepEqual(
        page.facts.state === "available" && page.facts.matches.map(({ fact }) => fact.id),
        action === "source" ? [] : [ProjectFactId.make("c")],
      );
      assert.isNull(page.facts.state === "available" && page.facts.nextCursor);
      const replay = yield* knowledge.search(input);
      assert.deepEqual(replay.facts.state === "available" && replay.facts.matches, []);
      const sql = yield* SqlClient.SqlClient;
      const untouched = yield* sql<{
        count: number;
      }>`SELECT retrieval_count AS count FROM project_knowledge_facts WHERE id = 'b'`;
      assert.equal(untouched[0]?.count, 0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["edit", "forget", "cancel"] as const)(
  "does not publish stale knowledge or false retrieval telemetry after %s during scoring",
  (action) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const scoring = Layer.effect(
        HolographicMemory.HolographicMemory,
        Effect.gen(function* () {
          const native = yield* HolographicMemory.HolographicMemory;
          return HolographicMemory.HolographicMemory.of({
            scoreCandidates: (input) =>
              native.scoreCandidates(input).pipe(
                Effect.tap(() => Deferred.succeed(entered, undefined)),
                Effect.tap(() => Deferred.await(release)),
              ),
          });
        }),
      ).pipe(Layer.provide(HolographicMemory.layer));
      yield* Effect.gen(function* () {
        const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make(`scoring-${action}`);
        yield* createProject(projectId);
        const fact = yield* knowledge.mutate(createFact(projectId), { kind: "user" });
        const requestId = CommandId.make(`search-${action}`);
        const fiber = yield* knowledge
          .search({ projectId, query: "tenant cache", requestId })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        if (action === "cancel") {
          yield* Fiber.interrupt(fiber);
        } else {
          yield* knowledge.mutate(
            action === "forget"
              ? {
                  action,
                  commandId: CommandId.make(action),
                  projectId,
                  factId: fact.id,
                  expectedRevision: 1,
                }
              : {
                  ...createFact(projectId),
                  action,
                  commandId: CommandId.make(action),
                  expectedRevision: 1,
                  content: "Region keys replaced tenant keys.",
                },
            { kind: "user" },
          );
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(fiber);
          assert.deepEqual(result.facts.state === "available" && result.facts.matches, []);
        }
        const rows = yield* sql<{
          retrieval_count: number;
        }>`SELECT retrieval_count FROM project_knowledge_facts WHERE id = ${fact.id}`;
        assert.equal(rows[0]?.retrieval_count, 0);
        if (action === "cancel")
          assert.deepEqual(
            yield* sql`SELECT command_id FROM project_knowledge_commands WHERE command_id = ${requestId}`,
            [],
          );
      }).pipe(Effect.provide(knowledgeTestLayer(scoring)));
    }),
);

it.effect("does not expose facts for a deleted project", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("deleted-project");
    yield* createProject(projectId);
    yield* knowledge.mutate(createFact(projectId), { kind: "user" });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_projects SET deleted_at = '2026-10-22T00:00:00.000Z' WHERE project_id = ${projectId}`;
    const result = yield* knowledge.list({ projectId }).pipe(Effect.result);
    assert.equal(Result.isFailure(result) && result.failure.reason, "missing_project");
  }).pipe(Effect.provide(layerTest)),
);
