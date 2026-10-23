import {
  EnvironmentId,
  MessageId,
  ProjectFactId,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ProjectKnowledgeDeliveries,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { deliveredKnowledgeNotes, deliveredKnowledgeSnapshot } from "./index.ts";

const delivery = (
  attemptId: string,
  status: ProjectKnowledgeDeliveries["deliveries"][number]["status"],
  text: string,
): ProjectKnowledgeDeliveries["deliveries"][number] => ({
  attemptId: RunAttemptId.make(attemptId),
  runId: RunId.make("run"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  projectId: ProjectId.make("project"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  status,
  items: [
    {
      contextId: "knowledge",
      label: "Knowledge",
      context: {
        environmentId: EnvironmentId.make("environment"),
        projectId: ProjectId.make("project"),
        selections: [{ kind: "fact", factId: ProjectFactId.make("fact"), revision: 1 }],
        maxBytes: 48000,
      },
      text,
      current: "changed",
    },
  ],
  omissions: [],
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
});

it("shows the copy the provider accepted, even when a later failover attempt was not confirmed", () => {
  const snapshot = deliveredKnowledgeSnapshot(
    {
      deliveries: [
        delivery("first", "uncertain", "first copy"),
        delivery("failover", "sent", "failover copy"),
        delivery("retry", "prepared", "retry copy"),
      ],
    },
    "knowledge",
  );
  expect(snapshot?.item.text).toBe("failover copy");
  expect(deliveredKnowledgeNotes(snapshot!)).toEqual([
    "Prepared for 3 provider attempts.",
    "This knowledge has changed since it was sent.",
  ]);
  expect(deliveredKnowledgeSnapshot({ deliveries: [] }, "knowledge")).toBeNull();
});
