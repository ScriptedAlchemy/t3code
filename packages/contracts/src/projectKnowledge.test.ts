import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProjectKnowledgeListResult, ProjectKnowledgeDelivery } from "./projectKnowledge.ts";

const decodeDelivery = Schema.decodeUnknownSync(ProjectKnowledgeDelivery);

const decodeList = Schema.decodeUnknownSync(ProjectKnowledgeListResult);
const encodeList = Schema.encodeSync(ProjectKnowledgeListResult);

const fact = (origin: Record<string, unknown>) => ({
  id: "fact-1",
  origin,
  projectId: "project-1",
  kind: "decision",
  revision: 1,
  trust: 0.5,
  retrievalCount: 0,
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
  content: "Cache keys include tenant IDs.",
  entities: [],
  tags: [],
  sources: [],
  status: "proposed",
  forgottenAt: null,
});

describe("KnowledgeOrigin", () => {
  it("decodes an origin kind from a newer server as unknown instead of failing the list", () => {
    const listed = decodeList({
      facts: [fact({ kind: "user" }), fact({ kind: "reviewer-bot", reviewer: "x" })],
      nextCursor: null,
    });
    expect(listed.facts.map((item) => item.origin)).toEqual([
      { kind: "user" },
      { kind: "unknown", originKind: "reviewer-bot" },
    ]);
    // Re-encoding keeps the original kind, so a store round trip does not relabel it.
    expect(encodeList(listed).facts[1]?.origin).toEqual({ kind: "reviewer-bot" });
  });

  it("still fails a known origin kind whose payload is broken", () => {
    expect(() =>
      decodeList({ facts: [fact({ kind: "assisted", threadId: "t" })], nextCursor: null }),
    ).toThrow();
  });
});

const oldDelivery = {
  attemptId: "attempt",
  runId: "run",
  threadId: "thread",
  messageId: "message",
  projectId: "project",
  providerInstanceId: "provider",
  status: "sent",
  items: [],
  omissions: [],
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
};
it("decodes old delivery receipts without budget assumptions", () => {
  expect(decodeDelivery(oldDelivery)).toEqual(oldDelivery);
});
it.each(["over_budget", "source_unavailable", "stale_revision", "not_permitted", "recall_failed"])(
  "decodes omission %s",
  (reason) => {
    const omissions = [{ contextId: "source", label: "Source", reason }];
    expect(decodeDelivery({ ...oldDelivery, omissions }).omissions).toEqual(omissions);
  },
);
