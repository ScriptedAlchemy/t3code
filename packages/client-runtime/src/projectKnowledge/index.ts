import { WS_METHODS, type ProjectKnowledgeDeliveries } from "@t3tools/contracts";
export { projectKnowledgeContextRecord } from "@t3tools/shared/composerContextReferences";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "../state/runtime.ts";

export function createProjectKnowledgeAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-knowledge:list",
      tag: WS_METHODS.projectKnowledgeList,
      staleTimeMs: 0,
    }),
    search: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-knowledge:search",
      tag: WS_METHODS.projectKnowledgeSearch,
      staleTimeMs: 0,
    }),
    readSource: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-knowledge:source",
      tag: WS_METHODS.projectKnowledgeReadSource,
      staleTimeMs: 0,
    }),
    readDeliveries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-knowledge:deliveries",
      tag: WS_METHODS.projectKnowledgeReadDeliveries,
      staleTimeMs: 0,
    }),
    prepareContext: createEnvironmentRpcCommand(runtime, {
      label: "project-knowledge:prepare",
      tag: WS_METHODS.projectKnowledgePrepareContext,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "project-knowledge:mutate",
      tag: WS_METHODS.projectKnowledgeMutate,
    }),
  };
}

type DeliveryRecord = ProjectKnowledgeDeliveries["deliveries"][number];

/**
 * What one sent message's knowledge reference actually delivered. Prefers the latest attempt the
 * provider accepted; otherwise the latest attempt, whose status explains why it is not confirmed.
 */
export function deliveredKnowledgeSnapshot(
  result: ProjectKnowledgeDeliveries,
  contextId: string,
): {
  readonly status: DeliveryRecord["status"];
  readonly item: DeliveryRecord["items"][number];
  readonly attempts: number;
} | null {
  const matches = result.deliveries.flatMap((delivery) => {
    const item = delivery.items.find((candidate) => candidate.contextId === contextId);
    return item ? [{ status: delivery.status, item }] : [];
  });
  const chosen = matches.findLast((match) => match.status === "sent") ?? matches.at(-1);
  return chosen ? { ...chosen, attempts: matches.length } : null;
}

export function deliveredKnowledgeNotes(
  snapshot: NonNullable<ReturnType<typeof deliveredKnowledgeSnapshot>>,
): ReadonlyArray<string> {
  const notes: string[] = [];
  if (snapshot.status === "prepared" || snapshot.status === "uncertain")
    notes.push("Delivery to the provider was not confirmed.");
  if (snapshot.status === "failed") notes.push("The provider refused this turn before reading it.");
  if (snapshot.attempts > 1) notes.push(`Prepared for ${snapshot.attempts} provider attempts.`);
  if (snapshot.item.current === "changed")
    notes.push("This knowledge has changed since it was sent.");
  if (snapshot.item.current === "forgotten")
    notes.push("This knowledge has since been forgotten. T3 keeps this copy of what was sent.");
  if (snapshot.item.current === "unavailable")
    notes.push("A source for this knowledge is no longer available.");
  return notes;
}
