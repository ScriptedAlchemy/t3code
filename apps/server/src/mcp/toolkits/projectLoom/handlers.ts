import { OrchestratorMcpFailure, type ProjectLoomError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProjectLoom from "../../../project/loom/ProjectLoom.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { ProjectLoomToolkit } from "./tools.ts";

const failure = (error: ProjectLoomError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(ProjectLoomToolkit, {
  t3_project_loom_read: McpToolAccess.reads((input) =>
    readCaller().pipe(
      Effect.andThen(ProjectLoom.ProjectLoom),
      Effect.flatMap((loom) => loom.readWindow(input).pipe(Effect.mapError(failure))),
    ),
  ),
});
