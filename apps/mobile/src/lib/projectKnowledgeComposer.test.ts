import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProjectFactId, ThreadId, MessageId } from "@t3tools/contracts";

import {
  projectKnowledgeComposerReference,
  projectKnowledgeRecordInScope,
  removeProjectKnowledgeReference,
} from "./projectKnowledgeComposer";
import { reidentifyComposerContext, serializeComposerMessageForServer } from "./composerContext";

describe("project knowledge composer references", () => {
  const knowledge = {
    environmentId: EnvironmentId.make("env-a"),
    projectId: ProjectId.make("project-a"),
    selections: [
      {
        kind: "fact" as const,
        factId: ProjectFactId.make("fact-a"),
        revision: 2 as const,
      },
      {
        kind: "message" as const,
        threadId: ThreadId.make("thread-a"),
        messageId: MessageId.make("message-a"),
        digest: "a".repeat(64),
      },
    ],
    maxBytes: 48_000,
  };

  it("keeps only scoped evidence references in the composer record", () => {
    const attached = projectKnowledgeComposerReference(knowledge);

    expect(attached.record.knowledge).toEqual(knowledge);
    expect(attached.record).not.toHaveProperty("text");
    expect(attached.context.records).toEqual([attached.record]);
    expect(
      projectKnowledgeRecordInScope(attached.record, {
        environmentId: knowledge.environmentId,
        projectId: knowledge.projectId,
      }),
    ).toBe(true);
    expect(
      projectKnowledgeRecordInScope(attached.record, {
        environmentId: EnvironmentId.make("env-b"),
        projectId: knowledge.projectId,
      }),
    ).toBe(false);
    expect(
      projectKnowledgeRecordInScope(attached.record, {
        environmentId: knowledge.environmentId,
        projectId: ProjectId.make("project-b"),
      }),
    ).toBe(false);
  });

  it("removes its reference while preserving prose and other context references", () => {
    const attached = projectKnowledgeComposerReference(knowledge);
    const other = "[thread](t3-context://v1/thread/thread-a)";
    const text = `Keep this ${attached.text} and this ${other}`;

    expect(removeProjectKnowledgeReference(text, attached.record)).toBe(
      `Keep this and this ${other}`,
    );
  });

  it("preserves the reference through clipboard reidentification and message serialization", () => {
    const attached = projectKnowledgeComposerReference(knowledge);
    const imported = reidentifyComposerContext(attached.text, [attached.record], () => "copied");
    const serialized = serializeComposerMessageForServer(imported.text, imported.context, true);

    expect(imported.context.records[0]).toMatchObject({
      kind: "project-knowledge",
      contextId: "copied",
      knowledge,
    });
    expect(imported.text).toContain("copied");
    expect(serialized.context?.records).toEqual(imported.context.records);
  });
});
