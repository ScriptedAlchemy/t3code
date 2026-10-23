import {
  ConversationSummaryDescribeInput,
  ConversationSummaryExpandInput,
  ConversationSummaryExpansion,
  ConversationSummaryList,
  ConversationSummaryListInput,
  ConversationSummaryRead,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
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
      "List the generated summaries of a thread's older messages, oldest first, with whether summarizing is on for the project and what the latest background pass did. Use when a handoff mentions a conversation summary or you need the gist of a long thread before reading it with t3_thread_read. A summary whose source messages changed or were removed is stale and returns no text. Paginate with cursor=nextCursor. Does not generate summaries.",
    parameters: ConversationSummaryListInput,
    success: ConversationSummaryList,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_conversation_summary_describe", {
    ...shared,
    description:
      "Read one conversation summary: its statements, the message ids each statement cites, and its exact source messages (ids and digests). The text is a model-written summary, not the conversation; check anything you rely on with t3_conversation_summary_expand. Stale summaries return no text.",
    parameters: ConversationSummaryDescribeInput,
    success: ConversationSummaryRead,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_conversation_summary_expand", {
    ...shared,
    description:
      "Return the exact original messages a conversation summary was written from, in order, as they are now. A message that changed, was removed, or sits in a deleted or archived thread returns a typed unavailable reason instead of text. Paginate with offset=nextOffset.",
    parameters: ConversationSummaryExpandInput,
    success: ConversationSummaryExpansion,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
