import {
  ComposerContextId,
  WS_METHODS,
  type ProjectKnowledgeContext,
  type ProjectKnowledgeContextRecord,
} from "@t3tools/contracts";
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

export function projectKnowledgeContextRecord(
  knowledge: ProjectKnowledgeContext,
): ProjectKnowledgeContextRecord {
  return {
    version: 1,
    kind: "project-knowledge",
    contextId: ComposerContextId.make("project-knowledge"),
    label: `Project knowledge (${knowledge.selections.length})`,
    knowledge,
  };
}
