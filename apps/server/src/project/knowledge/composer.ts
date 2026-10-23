import {
  ProjectKnowledgeError,
  type ComposerContextId,
  type ComposerContextRecord,
  type ProjectId,
  type ProjectKnowledgeDeliveryItem,
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
    const omissions = input.records.flatMap((record) =>
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
