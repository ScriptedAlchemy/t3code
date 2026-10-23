import {
  ActiveProjectFact,
  KnowledgeOrigin,
  ProjectKnowledgeError,
  type ProjectFact,
  type ProjectId,
  type ProjectKnowledgeContext,
  type ProjectKnowledgeDeliveries,
  type ProjectKnowledgeDelivery,
  type ProjectKnowledgeReadDeliveriesInput,
  type ProjectKnowledgeListInput,
  type ProjectKnowledgeListResult,
  ProjectKnowledgeMutation,
  ProjectKnowledgeSearchInput,
  ProjectFactId,
  type ProjectKnowledgePreparedContext,
  type ProjectKnowledgeReadSourceInput,
  type ProjectKnowledgeSearchResult,
  type ProjectKnowledgeSource,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  projectComposerContextForProvider,
  projectKnowledgeContextRecord,
} from "@t3tools/shared/composerContextReferences";
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
import { makeStore, type SearchReceipt } from "./persistence.ts";
import * as HolographicMemory from "./HolographicMemory.ts";
import { projectMemorySearchTokens } from "./holographicScoring.ts";

export class ProjectKnowledge extends Context.Service<
  ProjectKnowledge,
  {
    readonly list: (
      input: ProjectKnowledgeListInput,
    ) => Effect.Effect<ProjectKnowledgeListResult, ProjectKnowledgeError>;
    readonly mutate: (
      input: ProjectKnowledgeMutation,
      actor: KnowledgeOrigin,
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
    readonly recordDelivery: (
      delivery: ProjectKnowledgeDelivery,
    ) => Effect.Effect<void, ProjectKnowledgeError>;
    readonly readDeliveries: (
      input: ProjectKnowledgeReadDeliveriesInput,
    ) => Effect.Effect<ProjectKnowledgeDeliveries, ProjectKnowledgeError>;
  }
>()("t3/project/knowledge/ProjectKnowledge") {}

const encodeText = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const encodeMutation = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ actor: KnowledgeOrigin, input: ProjectKnowledgeMutation })),
);
const encodeSearch = Schema.encodeSync(Schema.fromJsonString(ProjectKnowledgeSearchInput));
const encodeQuery = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      projectId: ProjectKnowledgeSearchInput.fields.projectId,
      query: Schema.String,
      entities: Schema.Array(Schema.String),
      entityMatch: Schema.String,
      includeArchived: Schema.Boolean,
      minTrust: Schema.Number,
    }),
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
  const holographic = yield* HolographicMemory.HolographicMemory;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadSearch.ThreadSearch;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;

  const requireProject = Effect.fn("ProjectKnowledge.requireProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects.get(projectId).pipe(Effect.mapError(storageError(projectId)));
    if (Option.isNone(project) || project.value.deletedAt !== null)
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
    return true;
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
            if (input.action === "confirm" && actor.kind !== "user") {
              return yield* new ProjectKnowledgeError({
                reason: "user_confirmation_required",
                projectId,
                factId,
              });
            }
            if (input.action === "create" || input.action === "edit") {
              if (
                Buffer.byteLength(input.content) +
                  input.entities.reduce((size, entity) => size + Buffer.byteLength(entity), 0) >
                  16384 ||
                input.tags.some((tag) => Buffer.byteLength(tag) > 256)
              ) {
                return yield* new ProjectKnowledgeError({ reason: "fact_size", projectId, factId });
              }
              if (actor.kind !== "user" && input.sources.some((source) => source.kind === "user")) {
                return yield* new ProjectKnowledgeError({
                  reason: "invalid_source",
                  projectId,
                  factId,
                });
              }
              if (
                (actor.kind === "user" && input.sources.length === 0) ||
                !(yield* sourcesAvailable(input, true))
              ) {
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
                origin: actor,
                status: actor.kind === "user" ? "confirmed" : "proposed",
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
                    origin: actor,
                    status: actor.kind !== "user" ? "proposed" : existing.status,
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
  )(
    function* (input) {
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
            fact.status === "forgotten" ||
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
          const origin =
            fact.origin.kind === "user"
              ? "User assertion"
              : fact.origin.kind === "agent-thread"
                ? `Agent observation in thread ${fact.origin.threadId}`
                : `Agent observation from ${fact.origin.label}`;
          parts.push(
            `[Fact ${fact.id} revision:${fact.revision} status:${fact.status} trust:${fact.trust}; ${origin}${citations ? `; ${citations}` : ""}]\n${fact.content}`,
          );
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
    },
    (effect, input) =>
      sql.withTransaction(effect).pipe(Effect.mapError(storageError(input.projectId))),
  );
  const prepareContext: ProjectKnowledge["Service"]["prepareContext"] = Effect.fn(
    "ProjectKnowledge.prepareContext",
  )(function* (input) {
    const resolved = yield* resolveForTurn(input);
    const record = projectKnowledgeContextRecord(input);
    const text = projectComposerContextForProvider({
      text: formatComposerContextReference(record),
      records: [record],
      resolvedKnowledge: new Map([[record.contextId, resolved.text]]),
    });
    const byteLength = Buffer.byteLength(encodeText(text)) - Buffer.byteLength(encodeText(""));
    if (byteLength > input.maxBytes)
      return yield* new ProjectKnowledgeError({
        reason: "context_budget",
        projectId: input.projectId,
        byteLength,
      });
    return { context: input, text, byteLength };
  });
  const search: ProjectKnowledge["Service"]["search"] = Effect.fn("ProjectKnowledge.search")(
    function* (input) {
      yield* requireProject(input.projectId);
      const messages = yield* threads
        .search(input)
        .pipe(Effect.mapError(storageError(input.projectId)));
      const entities = [
        ...new Set((input.entities ?? []).map((entity) => entity.toLowerCase())),
      ].sort();
      const minTrust = input.minTrust ?? 0.3;
      const queryDigest = yield* digest(
        encodeQuery({
          projectId: input.projectId,
          query: input.query,
          entities,
          entityMatch: input.entityMatch ?? "any",
          includeArchived: input.includeArchived ?? false,
          minTrust,
        }),
      ).pipe(Effect.mapError(storageError(input.projectId)));
      const { cursor: _messageCursor, ...factInput } = input;
      const requestDigest = yield* digest(encodeSearch(factInput)).pipe(
        Effect.mapError(storageError(input.projectId)),
      );
      const prior = yield* store
        .receipt(input.requestId)
        .pipe(Effect.mapError(storageError(input.projectId)));
      if (
        prior !== null &&
        (prior.projectId !== input.projectId ||
          prior.factId !== null ||
          prior.digest !== requestDigest ||
          prior.search === null)
      ) {
        return yield* new ProjectKnowledgeError({
          reason: "command_reused",
          projectId: input.projectId,
        });
      }
      const rootRequestId =
        prior?.search?.rootRequestId ?? input.factCursor?.requestId ?? input.requestId;
      const rootReceipt =
        rootRequestId === input.requestId
          ? prior
          : yield* store
              .receipt(rootRequestId)
              .pipe(Effect.mapError(storageError(input.projectId)));
      if (
        (input.factCursor !== undefined || prior !== null) &&
        (rootReceipt === null ||
          rootReceipt.projectId !== input.projectId ||
          rootReceipt.search?.ranking == null ||
          rootReceipt.search.queryDigest !== queryDigest ||
          (input.factCursor?.offset ?? 0) > rootReceipt.search.ranking.matches.length)
      ) {
        return yield* new ProjectKnowledgeError({
          reason: "invalid_cursor",
          projectId: input.projectId,
        });
      }
      let ranking = rootReceipt?.search?.ranking ?? null;
      if (ranking === null) {
        const candidates = yield* store
          .candidates(input.projectId, projectMemorySearchTokens(input.query), entities, minTrust)
          .pipe(Effect.mapError(storageError(input.projectId)));
        const eligible = candidates.facts.filter(
          (fact): fact is typeof ActiveProjectFact.Type =>
            fact.status !== "forgotten" &&
            fact.content !== null &&
            (entities.length === 0 ||
              (input.entityMatch === "all"
                ? entities.every((entity) =>
                    fact.entities.some((value) => value.toLowerCase() === entity),
                  )
                : entities.some((entity) =>
                    fact.entities.some((value) => value.toLowerCase() === entity),
                  ))),
        );
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const scored = yield* holographic
          .scoreCandidates({
            query: input.query,
            now,
            candidates: eligible.map((fact) => ({
              id: fact.id,
              content: fact.content,
              entities: fact.entities,
              tags: fact.tags,
              trust: fact.trust,
              updatedAt: Date.parse(fact.updatedAt),
              retrievalCount: fact.retrievalCount,
              ...(candidates.ranks.has(fact.id) ? { ftsRank: candidates.ranks.get(fact.id)! } : {}),
            })),
          })
          .pipe(
            Effect.map((scores) => ({ state: "available" as const, scores })),
            Effect.catchTags({
              HolographicMemoryError: (cause) =>
                cause.reason === "unavailable"
                  ? Effect.succeed({ state: "unavailable" as const })
                  : Effect.fail(
                      new ProjectKnowledgeError({
                        reason: "scoring",
                        projectId: input.projectId,
                        cause,
                      }),
                    ),
            }),
          );
        if (scored.state === "unavailable")
          return { messages, facts: { state: "unavailable", reason: "kernel_unavailable" } };
        const snapshots = new Map(eligible.map((fact) => [fact.id, fact]));
        const matches = scored.scores.flatMap((score) => {
          const fact = snapshots.get(ProjectFactId.make(score.id));
          if (!fact) return [];
          return [
            {
              factId: fact.id,
              revision: fact.revision,
              updatedAt: fact.updatedAt,
              scoreMillionths: score.scoreMillionths,
              score: {
                holographic: score.holographic,
                lexical: score.fts,
                tokenOverlap: score.tokenOverlap,
                temporalDecay: score.decay,
                reinforcement: score.reinforcement,
                trust: fact.trust,
                combined: score.score,
              },
            },
          ];
        });
        matches.sort(
          (left, right) =>
            right.scoreMillionths - left.scoreMillionths ||
            (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0) ||
            (left.factId < right.factId ? -1 : left.factId > right.factId ? 1 : 0),
        );
        ranking = {
          matches: matches.map(({ factId, revision, score }) => ({ factId, revision, score })),
          coverage: candidates.partial ? "partial" : "complete",
        };
      }
      const initialRanking = ranking;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireProject(input.projectId);
            const receipt = yield* store.receipt(input.requestId);
            if (
              receipt !== null &&
              (receipt.projectId !== input.projectId ||
                receipt.factId !== null ||
                receipt.digest !== requestDigest)
            ) {
              return yield* new ProjectKnowledgeError({
                reason: "command_reused",
                projectId: input.projectId,
              });
            }
            const searchReceipt = receipt?.search ?? null;
            const ranked = searchReceipt?.ranking ?? initialRanking;
            const positions =
              searchReceipt?.positions ??
              ranked.matches.map((_, position) => position).slice(input.factCursor?.offset ?? 0);
            const current = new Map(
              (yield* store.findMany(
                input.projectId,
                positions.map((position) => ranked.matches[position]!.factId),
              )).map((fact) => [fact.id, fact]),
            );
            const matches = [];
            for (const position of positions) {
              const match = ranked.matches[position]!;
              const fact = current.get(match.factId);
              if (
                !fact ||
                fact.revision !== match.revision ||
                fact.status === "forgotten" ||
                fact.content === null ||
                !(yield* sourcesAvailable(fact, input.includeArchived ?? false))
              )
                continue;
              matches.push({ fact, score: match.score, position });
            }
            const selected = matches.slice(0, input.limit ?? 20);
            const last = selected.at(-1);
            const nextOffset =
              searchReceipt === null
                ? matches.length > selected.length && last !== undefined
                  ? last.position + 1
                  : null
                : searchReceipt.nextOffset;
            if (receipt === null) {
              yield* store.recordRetrieval(
                input.projectId,
                selected.map((match) => match.fact.id),
              );
              yield* store.record(input.requestId, input.projectId, null, requestDigest, {
                rootRequestId,
                queryDigest,
                ranking: input.factCursor === undefined ? ranked : null,
                positions: selected.map((match) => match.position),
                nextOffset,
              } satisfies SearchReceipt);
            }
            return {
              messages,
              facts: {
                state: "available" as const,
                matches: selected.map(({ fact, score }) => ({
                  fact:
                    receipt === null ? { ...fact, retrievalCount: fact.retrievalCount + 1 } : fact,
                  score,
                })),
                coverage: ranked.coverage,
                nextCursor:
                  nextOffset === null ? null : { requestId: rootRequestId, offset: nextOffset },
              },
            };
          }),
        )
        .pipe(Effect.mapError(storageError(input.projectId)));
    },
  );
  const recordDelivery: ProjectKnowledge["Service"]["recordDelivery"] = Effect.fn(
    "ProjectKnowledge.recordDelivery",
  )(function* (delivery) {
    yield* store.recordDelivery(delivery).pipe(Effect.mapError(storageError(delivery.projectId)));
  });
  const readDeliveries: ProjectKnowledge["Service"]["readDeliveries"] = Effect.fn(
    "ProjectKnowledge.readDeliveries",
  )(function* (input) {
    yield* requireProject(input.projectId);
    const rows = yield* store
      .deliveries(input.projectId, input.threadId, input.messageId)
      .pipe(Effect.mapError(storageError(input.projectId)));
    const facts = new Map<ProjectFactId, ProjectFact | null>();
    const selectionState = Effect.fn("ProjectKnowledge.deliveredSelectionState")(function* (
      context: ProjectKnowledgeContext,
    ) {
      const states = new Set<"changed" | "forgotten" | "unavailable">();
      for (const selection of context.selections) {
        if (selection.kind === "message") {
          const source = yield* readSource({
            projectId: input.projectId,
            ...selection,
            includeArchived: context.includeArchived ?? false,
          });
          if (source.state === "unavailable")
            states.add(source.reason === "changed" ? "changed" : "unavailable");
          continue;
        }
        if (!facts.has(selection.factId))
          facts.set(
            selection.factId,
            yield* store
              .find(input.projectId, selection.factId)
              .pipe(Effect.mapError(storageError(input.projectId))),
          );
        const fact = facts.get(selection.factId);
        if (!fact) states.add("unavailable");
        else if (fact.status === "forgotten") states.add("forgotten");
        else if (fact.revision !== selection.revision) states.add("changed");
      }
      return states.has("forgotten")
        ? ("forgotten" as const)
        : states.has("unavailable")
          ? ("unavailable" as const)
          : states.has("changed")
            ? ("changed" as const)
            : ("current" as const);
    });
    const deliveries = [];
    for (const row of rows) {
      const items = [];
      for (const item of row.items)
        items.push({ ...item, current: yield* selectionState(item.context) });
      deliveries.push({ ...row, items });
    }
    return { deliveries };
  });
  return ProjectKnowledge.of({
    list,
    mutate,
    readSource,
    search,
    prepareContext,
    resolveForTurn,
    recordDelivery,
    readDeliveries,
  });
});
export const layer = Layer.effect(ProjectKnowledge, make);
