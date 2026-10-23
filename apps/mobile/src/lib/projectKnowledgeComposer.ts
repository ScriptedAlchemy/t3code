import type {
  EnvironmentId,
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
