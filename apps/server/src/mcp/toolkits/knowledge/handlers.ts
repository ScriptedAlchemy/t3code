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
    Effect.gen(function* () {
      const { scope } = yield* readCaller();
      const service = yield* ProjectKnowledge.ProjectKnowledge;
      if (scope.thread !== undefined) {
        return yield* service
          .mutate(input, {
            kind: "agent-thread",
            threadId: scope.thread.threadId,
            providerInstanceId: scope.thread.providerInstanceId,
          })
          .pipe(Effect.mapError(failure));
      }
      if (scope.client !== undefined) {
        return yield* service
          .mutate(input, {
            kind: "agent-client",
            sessionId: scope.client.sessionId,
            label: scope.client.label,
          })
          .pipe(Effect.mapError(failure));
      }
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Knowledge observations require an authenticated agent caller.",
      });
    }),
  ),
});
