import {
  OrchestratorMcpFailure,
  ProjectCodeQueryInput,
  ProjectCodeQueryResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as CodeIntelligence from "../../../project/knowledge/CodeIntelligence.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const ProjectCodeToolkit = Toolkit.make(
  Tool.make("t3_project_code_query", {
    failure: OrchestratorMcpFailure,
    failureMode: "return" as const,
    dependencies: [
      CodeIntelligence.CodeIntelligence,
      ThreadManagement.ThreadManagementService,
      McpInvocationContext.McpInvocationContext,
    ],
    description:
      "Query the registered project's multilingual code graph before broad repository-reading loops. Supports bounded search, symbol lookup, callers, callees, references, dependencies, impact, and index status. Results include source digests, coverage, unresolved references, and edge evidence grades. Relations may be static candidates rather than compiler-resolved facts; inspect source when coverage is partial or stale, a selection is ambiguous, or evidence is heuristic. Project and optional thread IDs select an enrolled project and its exact registered worktree.",
    parameters: ProjectCodeQueryInput,
    success: ProjectCodeQueryResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
