import type { KnowledgeSelection, ProjectFact, ProjectFactId } from "@t3tools/contracts";

// Facts carry UUIDs; the prefix is enough to tell linked facts apart.
export const shortFactId = (id: ProjectFactId) => id.slice(0, 8);

export const factRowKey = (factId: ProjectFactId) => `fact:${factId}`;
export const messageRowKey = (ref: { threadId: string; messageId: string }) =>
  `message:${ref.threadId}:${ref.messageId}`;
export const selectionKey = (selection: KnowledgeSelection) =>
  selection.kind === "fact" ? factRowKey(selection.factId) : messageRowKey(selection);

const STATUS_BADGE = {
  confirmed: { label: "Confirmed", variant: "success" },
  proposed: { label: "Proposed", variant: "info" },
  forgotten: { label: "Forgotten", variant: "secondary" },
} as const;

export const factStatusBadge = (fact: ProjectFact) => STATUS_BADGE[fact.status];

// A pending assisted replacement names its target before the target is marked superseded.
export const isPendingReplacement = (fact: ProjectFact) =>
  fact.status === "proposed" && fact.origin.kind === "assisted" && fact.supersedes != null;
