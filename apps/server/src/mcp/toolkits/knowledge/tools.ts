import {
  OrchestratorMcpFailure,
  ProjectKnowledgeFactDetail,
  ProjectKnowledgeMutation,
  ProjectKnowledgeMutationResult,
  ProjectKnowledgeReadFactInput,
  ProjectKnowledgeStatus,
  ProjectKnowledgeStatusInput,
  ProjectKnowledgeListInput,
  ProjectKnowledgeListResult,
  ProjectKnowledgeReadSourceInput,
  ProjectKnowledgeSource,
  ProjectKnowledgeSearchInput,
  ProjectKnowledgeSearchResult,
  ProjectKnowledgeContext,
  ProjectKnowledgePreparedContext,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as ProjectKnowledge from "../../../project/knowledge/ProjectKnowledge.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    ProjectKnowledge.ProjectKnowledge,
    ThreadManagement.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};
export const KnowledgeToolkit = Toolkit.make(
  Tool.make("t3_knowledge_search", {
    ...shared,
    description:
      "Recall project facts and exact conversation citations. Facts use holographic and lexical ranking. Unavailable ranking is explicit. Superseded facts are excluded unless includeSuperseded is set. Reuse requestId for retries so retrieval is counted once.",
    parameters: ProjectKnowledgeSearchInput,
    success: ProjectKnowledgeSearchResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_knowledge_list", {
    ...shared,
    description:
      "List project facts, including proposed or forgotten facts when requested. Superseded facts are excluded unless includeSuperseded is set; sourceState unavailable lists only facts whose citations no longer resolve. This works independently of the retrieval kernel.",
    parameters: ProjectKnowledgeListInput,
    success: ProjectKnowledgeListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_knowledge_read_fact", {
    ...shared,
    description:
      "Read one project fact with its recent revision, confirmation, feedback and supersession history, linked superseding facts, and possible duplicates or conflicts found by lexical similarity.",
    parameters: ProjectKnowledgeReadFactInput,
    success: ProjectKnowledgeFactDetail,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_knowledge_status", {
    ...shared,
    description:
      "Summarize project memory health: fact counts by status, trust bands, facts below the default recall threshold, retrieval and feedback totals, and facts whose sources are unavailable.",
    parameters: ProjectKnowledgeStatusInput,
    success: ProjectKnowledgeStatus,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_knowledge_read_source", {
    ...shared,
    description:
      "Read the exact canonical message behind a citation. Deleted, changed and out-of-project sources return unavailable without old excerpts.",
    parameters: ProjectKnowledgeReadSourceInput,
    success: ProjectKnowledgeSource,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_knowledge_prepare_context", {
    ...shared,
    description:
      "Preview explicitly selected current project knowledge under a UTF-8 byte allowance. Returns references for the user to attach; it does not send a turn.",
    parameters: ProjectKnowledgeContext,
    success: ProjectKnowledgePreparedContext,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_knowledge_mutate", {
    ...shared,
    description:
      "Propose or edit sourced project knowledge, supersede a fact with a replacement, forget a fact, or give trust feedback. Agent observations may use an empty sources array; their origin is recorded from this authenticated caller. Proposed facts can be recalled immediately. Confirmation in the app is optional and remains a separate trust action. Agents cannot confirm or claim direct user assertions. Reuse commandId when retrying. Updates require the current revision. Supersede creates replacementFactId and keeps the old fact's content but removes it from recall; prefer it over forget when knowledge changed. Created, edited and replacement facts return hints naming possible duplicates or conflicts to review. Forgotten facts cannot be restored.",
    parameters: Schema.Struct({ mutation: ProjectKnowledgeMutation }),
    success: ProjectKnowledgeMutationResult,
  }).annotate(Tool.Destructive, true),
);
