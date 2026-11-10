import {
  CONVERSATION_SUMMARY_MAX_EXPANSION_CHARS,
  CONVERSATION_SUMMARY_MAX_SOURCES,
  ConversationSummaryError,
  WS_METHODS,
  type ConversationSummaryDescribeInput,
  type ConversationSummaryExpandInput,
  type ConversationSummaryExpansion,
  type ConversationSummaryListInput,
  type ConversationSummaryRead,
  type ConversationSummarySourceRef,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ConversationSummaries from "./project/conversationSummaries/ConversationSummaries.ts";

type SourceFormatInput<Input> = Input & { readonly sourceFormat?: 2 | 3 };

// Format 2 decodes ranges and tool evidence, but not a summary whose sources are summaries.
const condensedRead = (read: ConversationSummaryRead): boolean =>
  read.state === "available" && read.summary.sources.some((source) => source.kind === "summary");

const legacySource = (source: ConversationSummarySourceRef): boolean =>
  source.kind === "message" && source.range === undefined;

function legacyRead(read: ConversationSummaryRead): boolean {
  if (read.state === "stale") return true;
  if (!read.summary.sources.every(legacySource)) return false;
  const messageIds = new Set<string>(
    read.summary.sources.flatMap((source) => (source.kind === "message" ? [source.messageId] : [])),
  );
  return (
    messageIds.size === read.summary.sources.length &&
    read.summary.statements.every((statement) =>
      statement.citations.every((citation) => messageIds.has(citation)),
    )
  );
}

function legacyExpansion(
  input: ConversationSummaryExpandInput,
  page: ConversationSummaryExpansion,
): boolean {
  if (!legacyRead(page.summary)) return false;
  const sourceCount =
    page.summary.state === "available"
      ? page.summary.summary.sources.length
      : page.summary.sourceCount;
  const offset = input.offset ?? 0;
  const expectedCount = Math.min(
    input.limit ?? CONVERSATION_SUMMARY_MAX_SOURCES,
    sourceCount - offset,
  );
  const expectedNextOffset = offset + expectedCount < sourceCount ? offset + expectedCount : null;
  // Old web clients increase the source limit rather than following text cursors. Even
  // stopping exactly between sources is unsafe if the requested source-count page is short.
  return (
    page.sources.length === expectedCount &&
    page.nextOffset === expectedNextOffset &&
    (page.nextTextOffset ?? 0) === 0 &&
    page.sources.every(
      ({ ref, result }) =>
        legacySource(ref) &&
        (result.state === "unavailable" ||
          (legacySource(result.source) &&
            result.role !== "tool" &&
            (result.textOffset ?? 0) === 0 &&
            (result.totalChars ?? result.text.length) === result.text.length)),
    )
  );
}

const upgradeRequired = (projectId: ProjectId) =>
  new ConversationSummaryError({
    // A new error tag/reason would also fail old clients' error decoding. Their UI shows the
    // existing generic read error; the cause retains the actionable upgrade explanation.
    reason: "storage",
    projectId,
    cause: new Error(
      "Update this T3 Code client to read ranged summaries, tool evidence, bounded source pages and summaries of summaries.",
    ),
  });

/** WS compatibility only: domain callers and MCP keep the complete current source contract. */
export function conversationSummariesRpcHandlers(
  summaries: Pick<
    ConversationSummaries.ConversationSummaries["Service"],
    "list" | "describe" | "expand"
  >,
) {
  return {
    [WS_METHODS.conversationSummariesList]: Effect.fn("ConversationSummariesRpc.list")(function* ({
      sourceFormat,
      ...input
    }: SourceFormatInput<ConversationSummaryListInput>) {
      const result = yield* summaries.list(input);
      if (
        sourceFormat === undefined
          ? !result.summaries.every(legacyRead)
          : sourceFormat === 2 && result.summaries.some(condensedRead)
      )
        return yield* upgradeRequired(input.projectId);
      return result;
    }),
    [WS_METHODS.conversationSummariesDescribe]: Effect.fn("ConversationSummariesRpc.describe")(
      function* ({ sourceFormat, ...input }: SourceFormatInput<ConversationSummaryDescribeInput>) {
        const result = yield* summaries.describe(input);
        if (
          sourceFormat === undefined
            ? !legacyRead(result)
            : sourceFormat === 2 && condensedRead(result)
        )
          return yield* upgradeRequired(input.projectId);
        return result;
      },
    ),
    [WS_METHODS.conversationSummariesExpand]: Effect.fn("ConversationSummariesRpc.expand")(
      function* ({ sourceFormat, ...input }: SourceFormatInput<ConversationSummaryExpandInput>) {
        const result = yield* summaries.expand(
          sourceFormat !== undefined
            ? input
            : {
                ...input,
                maxChars: input.maxChars ?? CONVERSATION_SUMMARY_MAX_EXPANSION_CHARS,
              },
        );
        if (
          sourceFormat === undefined
            ? !legacyExpansion(input, result)
            : sourceFormat === 2 &&
              (condensedRead(result.summary) ||
                result.sources.some(({ ref }) => ref.kind === "summary"))
        )
          return yield* upgradeRequired(input.projectId);
        return result;
      },
    ),
  };
}
