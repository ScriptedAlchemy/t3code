import { OrchestratorMcpFailure, type ProjectKnowledgeError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProjectKnowledge from "../../../project/knowledge/ProjectKnowledge.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { KnowledgeToolkit } from "./tools.ts";

const failure = (error: ProjectKnowledgeError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });
const access = readCaller().pipe(Effect.andThen(ProjectKnowledge.ProjectKnowledge));
export const layer = McpToolAccess.toLayer(KnowledgeToolkit, {
  t3_knowledge_search: McpToolAccess.reads((input) =>
    Effect.flatMap(access, (service) => service.search(input)).pipe(
      Effect.mapError((error) => (error._tag === "ProjectKnowledgeError" ? failure(error) : error)),
    ),
  ),
  t3_knowledge_list: McpToolAccess.reads((input) =>
    Effect.flatMap(access, (service) => service.list(input)).pipe(
      Effect.mapError((error) => (error._tag === "ProjectKnowledgeError" ? failure(error) : error)),
    ),
  ),
  t3_knowledge_read_source: McpToolAccess.reads((input) =>
    Effect.flatMap(access, (service) => service.readSource(input)).pipe(
      Effect.mapError((error) => (error._tag === "ProjectKnowledgeError" ? failure(error) : error)),
    ),
  ),
  t3_knowledge_prepare_context: McpToolAccess.reads((input) =>
    Effect.flatMap(access, (service) => service.prepareContext(input)).pipe(
      Effect.mapError((error) => (error._tag === "ProjectKnowledgeError" ? failure(error) : error)),
    ),
  ),
  t3_knowledge_mutate: McpToolAccess.writesEnvironment((input) =>
    Effect.flatMap(ProjectKnowledge.ProjectKnowledge, (service) =>
      service.mutate(input, "agent"),
    ).pipe(Effect.mapError(failure)),
  ),
});
