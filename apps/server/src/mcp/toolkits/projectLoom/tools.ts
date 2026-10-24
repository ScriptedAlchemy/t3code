import { LoomWindow, LoomWindowInput, OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectLoom from "../../../project/loom/ProjectLoom.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const ProjectLoomToolkit = Toolkit.make(
  Tool.make("t3_project_loom_read", {
    failure: OrchestratorMcpFailure,
    failureMode: "return" as const,
    dependencies: [
      ProjectLoom.ProjectLoom,
      ThreadManagement.ThreadManagementService,
      McpInvocationContext.McpInvocationContext,
    ],
    description:
      "Read a project's activity timeline for a time window (default: the last 7 days): its threads as lanes with fork and subagent parents, runs with request, start and completion times, checkpoints with file counts, linked pull requests, commands that look like test runs, provider-native tasks, and fork or handoff transfers between threads. Use it to see what happened across a project recently or which thread did what when, before reading individual threads with t3_thread_read. Resolve projectId with t3_project_list. Activity ticks are omitted. A null time is unknown, not zero. A test command marker means a test command ran, not that tests passed. Limits apply per kind; check truncated, and page lanes with cursor=nextCursor using the returned from and to.",
    parameters: LoomWindowInput,
    success: LoomWindow,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
