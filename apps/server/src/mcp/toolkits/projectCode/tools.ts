import {
  OrchestratorMcpFailure,
  ProjectCodeQueryInput,
  ProjectCodeQueryResult,
  ProjectFileHistoryInput,
  ProjectFileHistoryResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as CodeIntelligence from "../../../project/knowledge/CodeIntelligence.ts";
import * as FileHistory from "../../../project/knowledge/FileHistory.ts";
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
      "Query the registered project's multilingual code graph for symbol, caller, callee, reference, dependency, or impact questions before broad repository-reading loops. Resolve projectId with t3_project_list and t3_project_read. Pass threadId when querying that thread's registered worktree. Supports bounded search, symbol lookup, callers, callees, references, dependencies, impact, tests (usages walked to test files), affected (changed declarations in a file with their callers and reaching tests), index status, and freshness (compares the existing index to the checkout without indexing). Results include source digests, coverage, unresolved references, and edge evidence grades. Relations may be static candidates rather than compiler-resolved facts; inspect source when coverage is partial or stale, a selection is ambiguous, or evidence is heuristic. Project and optional thread IDs select an enrolled project and its exact registered worktree.",
    parameters: ProjectCodeQueryInput,
    success: ProjectCodeQueryResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_project_file_history", {
    failure: OrchestratorMcpFailure,
    failureMode: "return" as const,
    dependencies: [
      FileHistory.FileHistory,
      ThreadManagement.ThreadManagementService,
      McpInvocationContext.McpInvocationContext,
    ],
    description:
      "List threads whose turn checkpoints included a project-relative file path, newest first. A checkpoint records every file that changed in its workspace since the previous checkpoint, including changes made by people or other threads sharing that workspace, so an entry means the file was present at that thread's checkpoint, not that the thread authored the change.",
    parameters: ProjectFileHistoryInput,
    success: ProjectFileHistoryResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
