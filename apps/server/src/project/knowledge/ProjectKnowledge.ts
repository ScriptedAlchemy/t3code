import {
  ProjectKnowledgeError,
  type ProjectFact,
  type ProjectId,
  type ProjectKnowledgeContext,
  type ProjectKnowledgeListInput,
  type ProjectKnowledgeListResult,
  ProjectKnowledgeMutation,
  type ProjectKnowledgePreparedContext,
  type ProjectKnowledgeReadSourceInput,
  type ProjectKnowledgeSearchInput,
  type ProjectKnowledgeSearchResult,
  type ProjectKnowledgeSource,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import { makeStore } from "./persistence.ts";

export class ProjectKnowledge extends Context.Service<
  ProjectKnowledge,
  {
    readonly list: (
      input: ProjectKnowledgeListInput,
    ) => Effect.Effect<ProjectKnowledgeListResult, ProjectKnowledgeError>;
    readonly mutate: (
      input: ProjectKnowledgeMutation,
      actor: "user" | "agent",
    ) => Effect.Effect<ProjectFact, ProjectKnowledgeError>;
    readonly readSource: (
      input: ProjectKnowledgeReadSourceInput,
    ) => Effect.Effect<ProjectKnowledgeSource, ProjectKnowledgeError>;
    readonly search: (
      input: ProjectKnowledgeSearchInput,
    ) => Effect.Effect<ProjectKnowledgeSearchResult, ProjectKnowledgeError>;
    readonly prepareContext: (
      input: ProjectKnowledgeContext,
    ) => Effect.Effect<ProjectKnowledgePreparedContext, ProjectKnowledgeError>;
    readonly resolveForTurn: (
      input: ProjectKnowledgeContext,
    ) => Effect.Effect<ProjectKnowledgePreparedContext, ProjectKnowledgeError>;
  }
>()("t3/project/knowledge/ProjectKnowledge") {}

const encodeMutation = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ actor: Schema.Literals(["user", "agent"]), input: ProjectKnowledgeMutation }),
  ),
);
const isKnowledgeError = Schema.is(ProjectKnowledgeError);
const storageError = (projectId: ProjectId) => (cause: unknown) =>
  isKnowledgeError(cause)
    ? cause
    : new ProjectKnowledgeError({ reason: "storage", projectId, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const digest = Effect.fn("ProjectKnowledge.digest")((text: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(Effect.map(Hex.encode)),
  );
  const store = yield* makeStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadSearch.ThreadSearch;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;

  const requireProject = Effect.fn("ProjectKnowledge.requireProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects.get(projectId).pipe(Effect.mapError(storageError(projectId)));
    if (Option.isNone(project))
      return yield* new ProjectKnowledgeError({ reason: "missing_project", projectId });
  });
  const readSource: ProjectKnowledge["Service"]["readSource"] = Effect.fn(
    "ProjectKnowledge.readSource",
  )(function* (input) {
    yield* requireProject(input.projectId);
    const projection = yield* projections
      .getThreadRecords(input.threadId, ["messages"], { messageIds: [input.messageId] })
      .pipe(
        Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
        Effect.mapError(storageError(input.projectId)),
      );
    if (projection === null) return { state: "unavailable", reason: "missing" };
    if (projection.thread.projectId !== input.projectId)
      return { state: "unavailable", reason: "wrong_project" };
    if (projection.thread.deletedAt !== null) return { state: "unavailable", reason: "deleted" };
    const archived = projection.thread.archivedAt !== null;
    if (archived && !input.includeArchived) return { state: "unavailable", reason: "archived" };
    const message = projection.messages.find((item) => item.id === input.messageId);
    if (!message || (message.role !== "user" && message.role !== "assistant"))
      return { state: "unavailable", reason: "missing" };
    if (message.streaming) return { state: "unavailable", reason: "streaming" };
    const contentDigest = yield* digest(message.text).pipe(
      Effect.mapError(storageError(input.projectId)),
    );
    if (input.digest !== undefined && input.digest !== contentDigest)
      return { state: "unavailable", reason: "changed" };
    return {
      state: "available",
      source: {
        kind: "message",
        threadId: input.threadId,
        messageId: input.messageId,
        digest: contentDigest,
      },
      text: message.text,
      title: projection.thread.title,
      role: message.role,
      createdAt: DateTime.formatIso(message.createdAt),
      archived,
    };
  });
  const sourcesAvailable = Effect.fn("ProjectKnowledge.sourcesAvailable")(function* (
    fact: Pick<ProjectFact, "projectId" | "sources">,
    includeArchived: boolean,
  ) {
    for (const source of fact.sources) {
      if (source.kind === "user") continue;
      const result = yield* readSource({ projectId: fact.projectId, ...source, includeArchived });
      if (result.state !== "available") return false;
    }
    return fact.sources.length > 0;
  });
  const list: ProjectKnowledge["Service"]["list"] = Effect.fn("ProjectKnowledge.list")(
    function* (input) {
      yield* requireProject(input.projectId);
      const limit = input.limit ?? 50;
      const rows = yield* store
        .list(input.projectId, input.status ?? "confirmed", input.afterId ?? null, limit + 1)
        .pipe(Effect.mapError(storageError(input.projectId)));
      const facts = rows.slice(0, limit);
      return { facts, nextCursor: rows.length > limit ? (facts.at(-1)?.id ?? null) : null };
    },
  );
  const mutate: ProjectKnowledge["Service"]["mutate"] = Effect.fn("ProjectKnowledge.mutate")(
    function* (input, actor) {
      const { projectId, factId } = input;
      const requestDigest = yield* digest(encodeMutation({ actor, input })).pipe(
        Effect.mapError(storageError(projectId)),
      );
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireProject(projectId);
            const prior = yield* store.receipt(input.commandId);
            const existing = yield* store.find(projectId, factId);
            if (prior !== null) {
              if (
                prior.projectId !== projectId ||
                prior.factId !== factId ||
                prior.digest !== requestDigest
              ) {
                return yield* new ProjectKnowledgeError({
                  reason: "command_reused",
                  projectId,
                  factId,
                });
              }
              if (existing === null)
                return yield* new ProjectKnowledgeError({
                  reason: "missing_fact",
                  projectId,
                  factId,
                });
              return existing;
            }
            if (input.action === "confirm" && actor !== "user") {
              return yield* new ProjectKnowledgeError({
                reason: "user_confirmation_required",
                projectId,
                factId,
              });
            }
            if (input.action === "create" || input.action === "edit") {
              if (actor === "agent" && input.sources.some((source) => source.kind === "user")) {
                return yield* new ProjectKnowledgeError({
                  reason: "invalid_source",
                  projectId,
                  factId,
                });
              }
              if (!(yield* sourcesAvailable(input, true))) {
                return yield* new ProjectKnowledgeError({
                  reason: "invalid_source",
                  projectId,
                  factId,
                });
              }
            }
            const now = DateTime.formatIso(yield* DateTime.now);
            let fact: ProjectFact;
            if (input.action === "create") {
              if (existing !== null)
                return yield* new ProjectKnowledgeError({
                  reason: existing.status === "forgotten" ? "forgotten" : "conflict",
                  projectId,
                  factId,
                  currentRevision: existing.revision,
                });
              fact = {
                id: factId,
                projectId,
                content: input.content,
                entities: input.entities,
                tags: input.tags,
                kind: input.kind,
                sources: input.sources,
                status: actor === "user" ? "confirmed" : "proposed",
                revision: 1,
                trust: 0.5,
                retrievalCount: 0,
                createdAt: now,
                updatedAt: now,
                forgottenAt: null,
              };
              yield* store.insert(fact);
            } else {
              if (existing === null)
                return yield* new ProjectKnowledgeError({
                  reason: "missing_fact",
                  projectId,
                  factId,
                });
              if (existing.status === "forgotten")
                return yield* new ProjectKnowledgeError({ reason: "forgotten", projectId, factId });
              if (existing.revision !== input.expectedRevision)
                return yield* new ProjectKnowledgeError({
                  reason: "conflict",
                  projectId,
                  factId,
                  currentRevision: existing.revision,
                });
              fact = { ...existing, revision: existing.revision + 1, updatedAt: now };
              switch (input.action) {
                case "edit":
                  fact = {
                    ...fact,
                    content: input.content,
                    entities: input.entities,
                    tags: input.tags,
                    kind: input.kind,
                    sources: input.sources,
                    status: actor === "agent" ? "proposed" : existing.status,
                  };
                  break;
                case "confirm":
                  if (!(yield* sourcesAvailable(existing, true)))
                    return yield* new ProjectKnowledgeError({
                      reason: "invalid_source",
                      projectId,
                      factId,
                    });
                  fact = { ...fact, status: "confirmed" };
                  break;
                case "forget":
                  fact = {
                    ...fact,
                    status: "forgotten",
                    content: null,
                    entities: [],
                    tags: [],
                    sources: [],
                    forgottenAt: now,
                  };
                  break;
                case "feedback":
                  fact = {
                    ...fact,
                    trust: Math.max(0, Math.min(1, fact.trust + (input.helpful ? 0.05 : -0.1))),
                  };
                  break;
              }
              if (!(yield* store.update(fact, input.expectedRevision)))
                return yield* new ProjectKnowledgeError({ reason: "conflict", projectId, factId });
            }
            yield* store.record(input.commandId, projectId, factId, requestDigest);
            return fact;
          }),
        )
        .pipe(Effect.mapError(storageError(projectId)));
    },
  );

  const resolveForTurn: ProjectKnowledge["Service"]["resolveForTurn"] = Effect.fn(
    "ProjectKnowledge.resolveForTurn",
  )(function* (input) {
    if (input.environmentId !== (yield* environment.getEnvironmentId))
      return yield* new ProjectKnowledgeError({
        reason: "wrong_environment",
        projectId: input.projectId,
      });
    yield* requireProject(input.projectId);
    const parts: string[] = [];
    for (const selection of input.selections) {
      if (selection.kind === "message") {
        const source = yield* readSource({
          projectId: input.projectId,
          ...selection,
          includeArchived: input.includeArchived ?? false,
        });
        if (source.state !== "available")
          return yield* new ProjectKnowledgeError({
            reason: "stale_context",
            projectId: input.projectId,
          });
        parts.push(
          `[Message ${selection.threadId}/${selection.messageId} sha256:${selection.digest}]\n${source.text}`,
        );
      } else {
        const fact = yield* store
          .find(input.projectId, selection.factId)
          .pipe(Effect.mapError(storageError(input.projectId)));
        if (
          fact === null ||
          fact.status !== "confirmed" ||
          fact.revision !== selection.revision ||
          fact.content === null ||
          !(yield* sourcesAvailable(fact, input.includeArchived ?? false))
        ) {
          return yield* new ProjectKnowledgeError({
            reason: "stale_context",
            projectId: input.projectId,
            factId: selection.factId,
          });
        }
        const citations = fact.sources
          .map((source) =>
            source.kind === "user"
              ? "User assertion"
              : `Message ${source.threadId}/${source.messageId} sha256:${source.digest}`,
          )
          .join("; ");
        parts.push(`[Fact ${fact.id} revision:${fact.revision}; ${citations}]\n${fact.content}`);
      }
    }
    const text = `Selected project knowledge (quoted source material):\n\n${parts.join("\n\n")}`;
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength > input.maxBytes)
      return yield* new ProjectKnowledgeError({
        reason: "context_budget",
        projectId: input.projectId,
        byteLength,
      });
    return { context: input, text, byteLength };
  });
  const prepareContext: ProjectKnowledge["Service"]["prepareContext"] = Effect.fn(
    "ProjectKnowledge.prepareContext",
  )(function* (input) {
    return yield* resolveForTurn(input);
  });
  const search: ProjectKnowledge["Service"]["search"] = Effect.fn("ProjectKnowledge.search")(
    function* (input) {
      yield* requireProject(input.projectId);
      const messages = yield* threads
        .search(input)
        .pipe(Effect.mapError(storageError(input.projectId)));
      return { messages, facts: { state: "unavailable", reason: "kernel_unavailable" } };
    },
  );
  return ProjectKnowledge.of({ list, mutate, readSource, search, prepareContext, resolveForTurn });
});
export const layer = Layer.effect(ProjectKnowledge, make);
