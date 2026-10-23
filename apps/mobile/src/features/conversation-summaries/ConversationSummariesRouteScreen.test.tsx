import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ConversationSummary,
  type ConversationSummaryExpandInput,
  type ConversationSummaryList,
  type ConversationSummaryListInput,
} from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  supported: true,
  focused: true,
  list: null as ConversationSummaryList | null,
  lists: [] as { environmentId: EnvironmentId; input: ConversationSummaryListInput }[],
  expansions: [] as { environmentId: EnvironmentId; input: ConversationSummaryExpandInput }[],
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => state.focused,
  useNavigation: () => ({ goBack: () => {} }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: () => <header>Conversation summaries</header>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../state/conversationSummaries", () => ({
  conversationSummariesSupportedAtom: () => state.supported,
  conversationSummaries: {
    list: (request: { environmentId: EnvironmentId; input: ConversationSummaryListInput }) => {
      state.lists.push(request);
      return state.list;
    },
    expand: (request: { environmentId: EnvironmentId; input: ConversationSummaryExpandInput }) => {
      state.expansions.push(request);
      const offset = request.input.offset ?? 0;
      const summary = state.list?.summaries[0];
      if (summary?.state !== "available") throw new Error("Expected summary");
      return {
        summary,
        sources: summary.summary.sources.slice(offset, offset + 6).map((ref, index) => ({
          ref,
          result:
            offset + index === 0
              ? { state: "unavailable", reason: "changed" }
              : {
                  state: "available",
                  role: "assistant",
                  text: "Exact source " + (offset + index + 1) + ": 日本語 🧪\n  unchanged.",
                },
        })),
        nextOffset: offset === 0 ? 6 : null,
      };
    },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (data: unknown) => ({ data, error: null, isPending: false }),
}));

import { ConversationSummariesRouteScreen } from "./ConversationSummariesRouteScreen";

function setup() {
  state.supported = true;
  state.focused = false;
  state.lists = [];
  state.expansions = [];
  state.list = null;
  const container = document.createElement("div");
  const root = createRoot(container);
  const rerender = () =>
    act(() =>
      root.render(
        <ConversationSummariesRouteScreen
          route={{
            params: { environmentId: "remote", projectId: "project", threadId: "thread" },
          }}
        />,
      ),
    );
  rerender();
  return {
    container,
    rerender,
    click: async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (node) => node.textContent === label,
      );
      if (!button) throw new Error("Missing button: " + label);
      await act(async () => button.click());
    },
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it("reads only while open and supported, shows pass/citations/stale reasons and pages exact sources", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using screen = setup();
  expect(state.lists).toEqual([]);
  state.focused = true;
  state.supported = false;
  screen.rerender();
  expect(state.lists).toEqual([]);
  const summary: ConversationSummary = {
    id: "summary:" + "a".repeat(64),
    projectId: ProjectId.make("project"),
    threadId: ThreadId.make("thread"),
    sources: Array.from({ length: 10 }, (_, index) => ({
      kind: "message",
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("message-" + index),
      digest: "a".repeat(64),
    })),
    statements: [
      {
        text: "Keep the canonical sources.",
        citations: [MessageId.make("message-0"), MessageId.make("message-9")],
      },
    ],
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    createdAt: "2026-10-23T00:00:00Z",
  };
  const staleId = "summary:" + "b".repeat(64);
  state.list = {
    enabled: true,
    lastPass: {
      runId: RunId.make("run"),
      result: "failed",
      reason: "No model",
      generated: 0,
      waitingMessages: 10,
      at: summary.createdAt,
    },
    summaries: [
      { state: "available", summary },
      {
        state: "stale",
        id: staleId,
        sourceCount: 10,
        createdAt: summary.createdAt,
        reason: "changed",
      },
    ],
    nextCursor: staleId,
  };
  state.supported = true;
  screen.rerender();
  expect(state.lists.at(-1)).toEqual({
    environmentId: "remote",
    input: { projectId: "project", threadId: "thread", limit: 20 },
  });
  expect(state.expansions).toEqual([]);
  expect(screen.container.textContent).toContain(
    "Last pass failed. No model 10 older messages wait",
  );
  expect(screen.container.textContent).toContain("Keep the canonical sources. [#1, #10]");
  expect(screen.container.textContent).toContain(
    "Outdated: source changed. The summary text is hidden",
  );
  await screen.click("Later summaries");
  expect(state.lists.at(-1)?.input.cursor).toBe(staleId);
  await screen.click("Earlier summaries");
  expect(state.lists.at(-1)?.input.cursor).toBeUndefined();
  await screen.click("Show source messages");
  expect(state.expansions.at(-1)).toEqual({
    environmentId: "remote",
    input: { projectId: "project", threadId: "thread", summaryId: summary.id, offset: 0, limit: 6 },
  });
  expect(screen.container.textContent).toContain("Source changed.");
  expect(screen.container.textContent).toContain("Exact source 2: 日本語 🧪\n  unchanged.");
  await screen.click("Next messages");
  expect(state.expansions.at(-1)?.input.offset).toBe(6);
  expect(screen.container.textContent).toContain("#7 · Assistant");
  expect(screen.container.textContent).not.toContain("Exact source 2:");
  expect(
    [...screen.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Next messages",
    )?.disabled,
  ).toBe(true);
  await screen.click("Previous messages");
  expect(state.expansions.at(-1)?.input.offset).toBe(0);
  await screen.click("Back to summaries");
  expect(screen.container.textContent).not.toContain("Exact source");
  state.focused = false;
  screen.rerender();
  const reads = state.lists.length;
  screen.rerender();
  expect(state.lists).toHaveLength(reads);
});
