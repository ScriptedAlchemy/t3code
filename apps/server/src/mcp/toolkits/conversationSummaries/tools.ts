import {
  ConversationSummaryDescribeInput,
  ConversationSummaryExpandInput,
  ConversationSummaryExpansion,
  ConversationSummaryList,
  ConversationSummaryListInput,
  ConversationSummaryRead,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ConversationSummaries from "../../../project/conversationSummaries/ConversationSummaries.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    ConversationSummaries.ConversationSummaries,
    ThreadManagement.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};

export const ConversationSummariesToolkit = Toolkit.make(
  Tool.make("t3_conversation_summary_list", {
    ...shared,
    description:
      "List stored thread summaries (messages/tool evidence), oldest first, with enabled status and last pass. query is a literal case-insensitive substring of statement text. Follow cursor=nextCursor with the same query. Never generates summaries.",
    parameters: Schema.Struct({
      ...ConversationSummaryListInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ConversationSummaryList,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_conversation_summary_describe", {
    ...shared,
    description:
      "Read a summary's statements, citation keys and sources: message/tool refs with digests and optional UTF-16 ranges (end exclusive), or a roll-up's child summary ids. Verify claims with t3_conversation_summary_expand. Stale summaries expose no text.",
    parameters: Schema.Struct({
      ...ConversationSummaryDescribeInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ConversationSummaryRead,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_conversation_summary_expand", {
    ...shared,
    description:
      "Read source ranges, or a roll-up's child summaries; expand a cited child for the original text. Changed, removed, archived or unfinished sources are unavailable. maxChars (default 12000, max 48000 UTF-16 units) bounds page text; limit bounds sources. Continue with offset=nextOffset AND textOffset=nextTextOffset even when offset repeats. null nextOffset ends paging.",
    parameters: Schema.Struct({
      ...ConversationSummaryExpandInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ConversationSummaryExpansion,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
