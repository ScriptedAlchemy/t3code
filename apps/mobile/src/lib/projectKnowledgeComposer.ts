import type {
  EnvironmentId,
  KnowledgeSelection,
  ProjectId,
  ProjectKnowledgeContext,
  ProjectKnowledgeContextRecord,
} from "@t3tools/contracts";
import { projectKnowledgeContextRecord } from "@t3tools/client-runtime/projectKnowledge";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";

export function projectKnowledgeRecordInScope(
  record: ProjectKnowledgeContextRecord,
  scope: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): boolean {
  return (
    record.knowledge.environmentId === scope.environmentId &&
    record.knowledge.projectId === scope.projectId
  );
}

export function projectKnowledgeComposerReference(knowledge: ProjectKnowledgeContext) {
  const record = projectKnowledgeContextRecord(knowledge);
  return {
    record,
    text: formatComposerContextReference(record),
    context: { version: 1 as const, records: [record] },
  };
}

export function removeProjectKnowledgeReference(
  text: string,
  record: ProjectKnowledgeContextRecord,
): string {
  let result = text;
  const matches = collectComposerContextReferences(text).filter(
    (reference) => reference.kind === record.kind && reference.contextId === record.contextId,
  );
  for (const reference of matches.reverse()) {
    let start = reference.start;
    let end = reference.end;
    const before = result[start - 1];
    const after = result[end];
    if (before === " " && after === " ") start -= 1;
    else if (before === " " || before === "\t") start -= 1;
    else if (after === " " || after === "\t") end += 1;
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

export const MAX_KNOWLEDGE_SELECTIONS = 20;

/**
 * Identity of a selection, without the message digest or fact revision. A refreshed source is the
 * same selection at a newer version, so toggling it removes the old one instead of adding a second.
 */
export const knowledgeSelectionKey = (selection: KnowledgeSelection) =>
  selection.kind === "fact"
    ? `fact:${selection.factId}`
    : `message:${selection.threadId}:${selection.messageId}`;

const sameVersion = (a: KnowledgeSelection, b: KnowledgeSelection) =>
  a.kind === "fact" && b.kind === "fact"
    ? a.revision === b.revision
    : a.kind === "message" && b.kind === "message" && a.digest === b.digest;

/** "changed" means the selection pins an older revision or digest than `current`. */
export function knowledgeSelectionState(
  selections: ReadonlyArray<KnowledgeSelection>,
  current: KnowledgeSelection,
): "unselected" | "selected" | "changed" {
  const key = knowledgeSelectionKey(current);
  const selected = selections.find((item) => knowledgeSelectionKey(item) === key);
  if (!selected) return "unselected";
  return sameVersion(selected, current) ? "selected" : "changed";
}

export function toggleKnowledgeSelection(
  selections: ReadonlyArray<KnowledgeSelection>,
  selection: KnowledgeSelection,
): ReadonlyArray<KnowledgeSelection> {
  const key = knowledgeSelectionKey(selection);
  return selections.some((item) => knowledgeSelectionKey(item) === key)
    ? selections.filter((item) => knowledgeSelectionKey(item) !== key)
    : [...selections, selection].slice(0, MAX_KNOWLEDGE_SELECTIONS);
}

export function refreshKnowledgeSelection(
  selections: ReadonlyArray<KnowledgeSelection>,
  current: KnowledgeSelection,
): ReadonlyArray<KnowledgeSelection> {
  const key = knowledgeSelectionKey(current);
  return selections.map((item) => (knowledgeSelectionKey(item) === key ? current : item));
}
