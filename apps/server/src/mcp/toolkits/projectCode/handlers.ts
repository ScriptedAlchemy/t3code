import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as CodeIntelligence from "../../../project/knowledge/CodeIntelligence.ts";
import * as FileHistory from "../../../project/knowledge/FileHistory.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { ProjectCodeToolkit } from "./tools.ts";

const queryFailure = (
  error:
    | CodeIntelligence.CodeIntelligenceProjectNotFound
    | CodeIntelligence.CodeIntelligenceThreadMismatch
    | CodeIntelligence.CodeIntelligencePathOutsideCheckout
    | CodeIntelligence.CodeIntelligenceInspectionFailed,
) => {
  switch (error._tag) {
    case "CodeIntelligenceProjectNotFound":
      return new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The project is not available for code analysis.",
      });
    case "CodeIntelligenceThreadMismatch":
      return new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The selected thread does not belong to this project.",
      });
    case "CodeIntelligencePathOutsideCheckout":
      return new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The selected path is outside the registered project checkout.",
      });
    case "CodeIntelligenceInspectionFailed":
      return new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: `The code graph query failed for '${error.path}' (${error.reason}).`,
      });
    default:
      return unavailable();
  }
};

const denyProjectCode = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "This credential does not have filesystem:read access for project code queries.",
  });

export const layer = McpToolAccess.toLayer(ProjectCodeToolkit, {
  t3_project_code_query: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("project-code").pipe(
        Effect.mapError(() => denyProjectCode()),
      );
      yield* readCaller();
      if (
        scope.thread !== undefined &&
        input.threadId !== undefined &&
        input.threadId !== scope.thread.threadId
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "thread_not_found",
          message: "The selected thread is not available to this credential.",
        });
      }
      const code = yield* CodeIntelligence.CodeIntelligence;
      return yield* code
        .query(input)
        .pipe(
          Effect.mapError((error) =>
            error._tag === "CodeIntelligenceProjectNotFound" ||
            error._tag === "CodeIntelligenceThreadMismatch" ||
            error._tag === "CodeIntelligencePathOutsideCheckout" ||
            error._tag === "CodeIntelligenceInspectionFailed"
              ? queryFailure(error)
              : unavailable(),
          ),
        );
    }),
  ),
  t3_project_file_history: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const history = yield* FileHistory.FileHistory;
      return yield* history.read(input).pipe(
        Effect.mapError((error) =>
          error._tag === "FileHistoryProjectNotFound"
            ? new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "The project is not available for file history.",
              })
            : unavailable(),
        ),
      );
    }),
  ),
});
