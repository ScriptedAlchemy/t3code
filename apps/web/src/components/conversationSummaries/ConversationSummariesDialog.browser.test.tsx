import "../../index.css";
import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ConversationSummary,
  type ConversationSummaryExpansion,
  type ConversationSummaryList,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  config: null as unknown,
  list: null as unknown,
  expand: null as unknown,
  updateSettings: vi.fn(),
}));
vi.mock(
  import("../../state/server"),
  () =>
    ({
      serverEnvironment: {
        configValueAtom: () => state.config,
        updateSettings: { label: "updateSettings" },
      },
    }) as never,
);
vi.mock(import("../../state/session"), () => ({ useEnvironmentScope: () => true }) as never);
vi.mock(
  import("../../state/conversationSummaries"),
  () =>
    ({
      conversationSummaries: { list: () => state.list, expand: () => state.expand },
    }) as never,
);
vi.mock(
  import("../../state/use-atom-command"),
  () => ({ useAtomCommand: () => state.updateSettings }) as never,
);

import { ConversationSummariesDialog } from "./ConversationSummariesDialog";

const scope = {
  environmentId: EnvironmentId.make("summaries-browser"),
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
};
const ref = (id: string) => ({
  kind: "message" as const,
  threadId: scope.threadId,
  messageId: MessageId.make(id),
  digest: "a".repeat(64),
});
const summary: ConversationSummary = {
  id: `summary:${"b".repeat(64)}`,
  projectId: scope.projectId,
  threadId: scope.threadId,
  sources: [ref("first"), ref("second")],
  statements: [
    {
      text: "The user wants releases signed.",
      citations: [MessageId.make("first"), MessageId.make("second")],
    },
  ],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  createdAt: "2026-10-22T00:00:00.000Z",
};

function setup() {
  const registry = AtomRegistry.make();
  state.config = Atom.make({
    environment: { capabilities: { conversationSummaries: true, projectSettingsOverrides: true } },
    settings: DEFAULT_SERVER_SETTINGS,
  });
  const list: ConversationSummaryList = {
    enabled: false,
    lastPass: {
      runId: RunId.make("run"),
      result: "failed",
      reason: "No model",
      generated: 0,
      waitingMessages: 3,
      at: summary.createdAt,
    },
    summaries: [
      { state: "available", summary },
      {
        state: "stale",
        id: `summary:${"c".repeat(64)}`,
        sourceCount: 12,
        createdAt: summary.createdAt,
        reason: "changed",
      },
    ],
    nextCursor: null,
  };
  state.list = Atom.make(AsyncResult.success(list));
  const expansion: ConversationSummaryExpansion = {
    summary: { state: "available", summary },
    sources: [
      {
        ref: ref("first"),
        result: {
          state: "available",
          source: ref("first"),
          text: "Please sign every release bundle.",
          title: "Thread",
          role: "user",
          createdAt: summary.createdAt,
          archived: false,
        },
      },
      { ref: ref("second"), result: { state: "unavailable", reason: "deleted" } },
    ],
    nextOffset: null,
  };
  state.expand = Atom.make(AsyncResult.success(expansion));
  state.updateSettings.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  return registry;
}

it("shows current summaries with their sources, hides outdated text, and opts the project in", async () => {
  const registry = setup();
  await using _screen = await render(
    <RegistryContext.Provider value={registry}>
      <ConversationSummariesDialog {...scope} open onOpenChange={vi.fn()} />
    </RegistryContext.Provider>,
  );

  await expect.element(page.getByText(/The user wants releases signed\./)).toBeVisible();
  await expect.element(page.getByText("[#1, #2]")).toBeVisible();
  await expect
    .element(page.getByText("Last pass failed. No model 3 older messages wait for a summary."))
    .toBeVisible();
  await expect.element(page.getByText(/Outdated: source changed\./)).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Show source messages" }).first());
  await expect.element(page.getByText("Please sign every release bundle.")).toBeVisible();
  await expect.element(page.getByText("Source deleted.")).toBeVisible();

  await userEvent.click(page.getByRole("switch", { name: "Summarize older messages" }));
  expect(state.updateSettings).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: {
      patch: {
        projectSettingsOverrides: { [scope.projectId]: { enableConversationSummaries: true } },
      },
    },
  });
});
