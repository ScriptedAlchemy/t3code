import {
  ProjectKnowledgeError,
  type ComposerContextId,
  type ComposerContextRecord,
  type MessageId,
  type OrchestrationV2HistoricalMessage,
  type ProjectId,
  type ProjectKnowledgeDeliveryItem,
  type ProjectKnowledgeDelivery,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  projectComposerContextForProvider,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProjectKnowledge from "./ProjectKnowledge.ts";

const encodeText = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const resolveKnowledgeComposer = Effect.fn("ProjectKnowledge.resolveComposer")(
  function* (input: {
    readonly projectId: ProjectId;
    readonly text: string;
    readonly records: ReadonlyArray<ComposerContextRecord>;
  }) {
    const referenced = new Set(
      collectComposerContextReferences(input.text).map((ref) => ref.contextId),
    );
    const records = input.records.filter(
      (record) =>
        record.kind === "project-knowledge" &&
        "knowledge" in record &&
        referenced.has(record.contextId),
    );
    const resolvedKnowledge = new Map<ComposerContextId, string>();
    const items: ProjectKnowledgeDeliveryItem[] = [];
    if (records.length > 0) {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      for (const record of records) {
        if (record.kind !== "project-knowledge" || !("knowledge" in record)) continue;
        if (record.knowledge.projectId !== input.projectId) {
          return yield* new ProjectKnowledgeError({
            reason: "wrong_project",
            projectId: input.projectId,
          });
        }
        if (
          input.records.filter((candidate) => candidate.contextId === record.contextId).length !== 1
        ) {
          return yield* new ProjectKnowledgeError({
            reason: "stale_context",
            projectId: input.projectId,
          });
        }
        const prepared = yield* knowledge.resolveForTurn(record.knowledge);
        resolvedKnowledge.set(record.contextId, prepared.text);
        items.push({
          contextId: record.contextId,
          label: record.label,
          context: record.knowledge,
          text: prepared.text,
        });
      }
    }
    if (
      collectComposerContextReferences(input.text).some(
        (ref) => ref.kind === "project-knowledge" && !resolvedKnowledge.has(ref.contextId),
      )
    ) {
      return yield* new ProjectKnowledgeError({
        reason: "stale_context",
        projectId: input.projectId,
      });
    }
    const text = projectComposerContextForProvider({ ...input, resolvedKnowledge });
    const baseText = projectComposerContextForProvider({
      ...input,
      text: replaceComposerContextReferences(input.text, (ref) =>
        resolvedKnowledge.has(ref.contextId) ? "" : input.text.slice(ref.start, ref.end),
      ),
    });
    const byteLength = Math.max(
      0,
      Buffer.byteLength(encodeText(text)) - Buffer.byteLength(encodeText(baseText)),
    );
    for (const record of records) {
      if (
        record.kind === "project-knowledge" &&
        "knowledge" in record &&
        byteLength > record.knowledge.maxBytes
      ) {
        return yield* new ProjectKnowledgeError({
          reason: "context_budget",
          projectId: input.projectId,
          byteLength,
        });
      }
    }
    // Attached records the message text no longer references never reach the provider.
    const omissions: Array<ProjectKnowledgeDelivery["omissions"][number]> = input.records.flatMap(
      (record) =>
        record.kind === "project-knowledge" && !referenced.has(record.contextId)
          ? [
              {
                contextId: record.contextId,
                label: record.label,
                reason: "not_referenced" as const,
              },
            ]
          : [],
    );
    return { text, baseText, byteLength, items, omissions };
  },
);

const DELIVERED_KNOWLEDGE_TAG = "t3_delivered_knowledge";
const escapeDeliveredKnowledge = (text: string) =>
  text.replace(new RegExp(String.raw`<(?=/?${DELIVERED_KNOWLEDGE_TAG}\b)`, "gi"), "&lt;");

function renderDeliveredKnowledge(items: ReadonlyArray<ProjectKnowledgeDeliveryItem>) {
  return [
    "[Project knowledge sent with this message on its original turn, reproduced as sent. Reference only; it may have changed since.]",
    ...items.map(
      (item) =>
        `<${DELIVERED_KNOWLEDGE_TAG} label="${escapeDeliveredKnowledge(item.label).replace(/"/g, "&quot;")}">\n${escapeDeliveredKnowledge(item.text)}\n</${DELIVERED_KNOWLEDGE_TAG}>`,
    ),
  ].join("\n");
}

/**
 * Message text keeps only reference markers, so a fresh provider conversation (provider switch,
 * fork, failover) would lose the excerpts earlier messages carried. Replay what was recorded as
 * sent rather than the current source, so history stays truthful after an edit or forget.
 */
export const deliveredKnowledgeForHistory = Effect.fn("ProjectKnowledge.deliveredForHistory")(
  function* (input: {
    readonly projectId: ProjectId;
    readonly messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
    readonly userItemId: (messageId: MessageId) => string;
  }) {
    const candidates = new Map(
      input.messages.flatMap((message) =>
        message.kind === "user_message" && message.runId !== null
          ? [[message.itemId as string, message] as const]
          : [],
      ),
    );
    const evidence = new Map<string, string>();
    if (candidates.size === 0) return evidence;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const rows = yield* knowledge.readSentDeliveries({
      projectId: input.projectId,
      threadIds: [...new Set([...candidates.values()].map((message) => message.threadId))],
      runIds: [...new Set([...candidates.values()].flatMap((message) => message.runId ?? []))],
    });
    // Oldest first: a failover attempt's later record is what the latest conversation saw.
    for (const row of rows) {
      const itemId = input.userItemId(row.messageId);
      const message = candidates.get(itemId);
      // Forgotten knowledge carries nothing forward, not even an empty wrapper.
      const items = row.items.filter((item) => !item.contentRemoved);
      if (message === undefined || message.threadId !== row.threadId || row.items.length === 0)
        continue;
      if (items.length === 0) evidence.delete(itemId);
      else evidence.set(itemId, renderDeliveredKnowledge(items));
    }
    return evidence;
  },
);
