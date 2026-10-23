import "../../index.css";
import { RegistryContext } from "@effect/atom-react";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  RunId,
  ProjectId,
  ThreadId,
  ProjectFactId,
  MessageId,
  type ProjectFact,
  type ProjectFactHistoryEntry,
  type ProjectKnowledgeStatus,
  type ProjectKnowledgeSearchInput,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render, type Screen } from "../../../test/render";

const state = vi.hoisted(() => ({
  config: null as unknown,
  permission: null as unknown,
  list: null as unknown,
  listRequest: vi.fn(),
  detail: null as unknown,
  readFact: vi.fn(),
  status: null as unknown,
  search: null as unknown,
  searchRequest: vi.fn(),
  source: null as unknown,
  prepare: vi.fn(),
  mutate: vi.fn(),
  readSource: vi.fn(),
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
  import("../../state/projectKnowledge"),
  () =>
    ({
      projectKnowledge: {
        list: (input: unknown) => {
          state.listRequest(input);
          return state.list;
        },
        readFact: (input: unknown) => {
          state.readFact(input);
          return state.detail;
        },
        status: () => state.status,
        search: (input: unknown) => state.searchRequest(input),
        readSource: (input: unknown) => {
          state.readSource(input);
          return state.source;
        },
        prepareContext: { label: "prepare" },
        mutate: { label: "mutate", permissionAtom: () => state.permission },
      },
    }) as never,
);
vi.mock(
  import("../../state/use-atom-command"),
  () =>
    ({
      useAtomCommand: (command: { label: string }) =>
        command.label === "prepare"
          ? state.prepare
          : command.label === "updateSettings"
            ? state.updateSettings
            : state.mutate,
    }) as never,
);

import { ConfirmDialogHost } from "../ConfirmDialogHost";
import {
  DraftId,
  useComposerDraftStore,
  partializeComposerDraftStoreState,
} from "../../composerDraftStore";
import {
  ProjectMemoryDialogHost,
  ProjectMemoryPanel,
  useOpenProjectMemory,
} from "./ProjectMemoryPanel";

const scope = {
  environmentId: EnvironmentId.make("memory-browser"),
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
};
const target = { environmentId: scope.environmentId, threadId: scope.threadId };
const source = {
  kind: "message" as const,
  threadId: scope.threadId,
  messageId: MessageId.make("evidence"),
  digest: "a".repeat(64),
};
const fact: ProjectFact = {
  id: ProjectFactId.make("fact"),
  projectId: scope.projectId,
  origin: { kind: "agent-client", sessionId: "client", label: "Code agent" },
  content: "Cache keys include tenant IDs.",
  entities: ["cache"],
  tags: [],
  kind: "constraint",
  sources: [source],
  status: "proposed",
  revision: 1,
  trust: 0.5,
  retrievalCount: 0,
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
  forgottenAt: null,
};
const healthStatus: ProjectKnowledgeStatus = {
  counts: { proposed: 1, confirmed: 4, superseded: 1, forgotten: 0 },
  trustBands: { low: 0, guarded: 1, steady: 3, high: 1 },
  recallThreshold: 0.3,
  belowRecallThreshold: 0,
  retrievals: 7,
  feedback: { helpful: 2, unhelpful: 1 },
  unavailableSources: 0,
  unavailableSourcesCoverage: "complete",
};
const historyEntry = (
  entry: Pick<ProjectFactHistoryEntry, "sequence" | "event" | "revision" | "trustAfter"> &
    Partial<ProjectFactHistoryEntry>,
): ProjectFactHistoryEntry => ({
  actor: { kind: "user" },
  at: fact.createdAt,
  contentDigest: null,
  content: null,
  sources: [],
  trustBefore: null,
  helpful: null,
  relatedFactId: null,
  sourceUnavailable: null,
  ...entry,
});
async function setup(viewport: "desktop" | "narrow" = "desktop") {
  await page.viewport(viewport === "desktop" ? 1280 : 390, 900);
  const registry = AtomRegistry.make();
  state.config = Atom.make({
    environment: { capabilities: { projectKnowledge: true, projectKnowledgeHistory: true } },
  });
  state.permission = Atom.make(true);
  state.list = Atom.make(AsyncResult.success({ facts: [fact], nextCursor: null }));
  state.listRequest.mockReset();
  state.readFact.mockReset();
  state.detail = Atom.make(AsyncResult.initial(true));
  state.status = Atom.make(AsyncResult.success(healthStatus));
  state.search = Atom.make(
    AsyncResult.success({
      messages: { matches: [], nextCursor: null },
      facts: {
        state: "available",
        matches: [
          {
            fact,
            score: {
              holographic: 0.8,
              lexical: 0.9,
              tokenOverlap: 0.5,
              temporalDecay: 1,
              reinforcement: 1,
              trust: 0.5,
              combined: 0.6,
            },
          },
        ],
        coverage: "complete",
        nextCursor: null,
      },
    }),
  );
  state.source = Atom.make(
    AsyncResult.success({
      state: "available",
      source,
      text: "Exact canonical evidence.",
      title: "Source thread",
      role: "assistant",
      createdAt: fact.createdAt,
      archived: false,
    }),
  );
  state.prepare.mockReset().mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: { context: input, text: "Escaped provider preview.", byteLength: 25 },
  }));
  state.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: { ...fact, revision: 2 } });
  state.readSource.mockReset();
  state.updateSettings.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.searchRequest.mockReset().mockImplementation(() => state.search);
  useComposerDraftStore.getState().clearComposerContent(target);
  return registry;
}

async function mount(
  registry: ReturnType<typeof AtomRegistry.make>,
  composerDraftTarget = target as typeof target | DraftId,
) {
  return render(
    <RegistryContext.Provider value={registry}>
      <ProjectMemoryPanel environmentId={scope.environmentId} projectId={scope.projectId} />
      <ProjectMemoryDialogHost {...scope} composerDraftTarget={composerDraftTarget} />
      <ConfirmDialogHost />
    </RegistryContext.Provider>,
  );
}

const factList = () => page.getByRole("list", { name: "Project facts" });
const factRow = (content: string) => factList().getByRole("button", { name: new RegExp(content) });
const inspector = () => page.getByRole("region", { name: "Inspector" });
const draftFooter = () => page.getByRole("region", { name: "Draft selection" });

it("attaches project memory to the queued-edit composer without changing the thread draft", async () => {
  const registry = await setup();
  const editTarget = DraftId.make("queued-edit:memory-browser:run");
  const store = useComposerDraftStore.getState();
  store.clearComposerContent(editTarget);
  store.setPrompt(target, "Ordinary draft stays here.");
  store.setPrompt(editTarget, "Queued message edit.");
  await using screen = await mount(registry, editTarget);
  await openMemory(screen);
  await page.getByRole("checkbox", { name: /Select for draft/ }).click();
  await page.getByRole("button", { name: "Preview and attach" }).click();
  await expect.element(page.getByText("Escaped provider preview.")).toBeVisible();
  expect(store.getComposerDraft(editTarget)?.knowledgeContexts?.[0]?.knowledge.selections).toEqual([
    { kind: "fact", factId: fact.id, revision: 1 },
  ]);
  expect(store.getComposerDraft(target)?.prompt).toBe("Ordinary draft stays here.");
  expect(store.getComposerDraft(target)?.knowledgeContexts ?? []).toEqual([]);
});

async function openMemory(screen: { getByRole: Screen["getByRole"] }) {
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
}

it("opens exact evidence and attaches only references, then removes the attachment", async () => {
  const registry = await setup();
  await using screen = await mount(registry);
  await openMemory(screen);
  await factRow(fact.content!).click();
  await inspector().getByRole("button", { name: "Message evidence" }).click();
  await expect.element(page.getByText("Exact canonical evidence.")).toBeVisible();
  expect(state.readSource).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: { projectId: scope.projectId, ...source, includeArchived: false },
  });
  await page.getByRole("checkbox", { name: /Select for draft/ }).click();
  await page.getByRole("button", { name: "Preview and attach" }).click();
  await expect.element(page.getByText("Escaped provider preview.")).toBeVisible();
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  expect(draft?.knowledgeContexts?.[0]?.knowledge.selections).toEqual([
    { kind: "fact", factId: fact.id, revision: 1 },
  ]);
  expect(
    JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
  ).not.toContain("canonical evidence");
  expect(JSON.stringify(draft?.knowledgeContexts)).not.toContain(fact.content);
  await page.getByRole("checkbox", { name: "Include archived conversations" }).click();
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.knowledgeContexts).toEqual([]);
  await page.getByRole("button", { name: "Preview and attach" }).click();
  await expect.element(page.getByText("Escaped provider preview.")).toBeVisible();
  await page.getByRole("button", { name: "Clear selection" }).click();
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.knowledgeContexts).toEqual([]);
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).not.toContain(
    "t3-context",
  );
});

it("inspecting a fact shows its evidence without selecting it for the draft", async () => {
  const registry = await setup();
  const other = { ...fact, id: ProjectFactId.make("other"), content: "Workers retry twice." };
  state.list = Atom.make(AsyncResult.success({ facts: [fact, other], nextCursor: null }));
  await using screen = await mount(registry);
  await openMemory(screen);
  await expect.element(inspector().getByText("Select a fact to inspect")).toBeVisible();

  await factRow(fact.content!).click();
  await expect.element(factRow(fact.content!)).toHaveAttribute("aria-current", "true");
  await expect.element(inspector().getByText(fact.content!)).toBeVisible();
  await expect.element(inspector().getByText("Agent observation from Code agent")).toBeVisible();
  await expect.element(draftFooter().getByText("Nothing selected")).toBeVisible();
  expect(state.readFact).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: { projectId: scope.projectId, factId: fact.id },
  });

  await page.getByRole("checkbox", { name: `Select for draft: ${other.content}` }).click();
  await expect.element(draftFooter().getByText("1 selected")).toBeVisible();
  await expect.element(inspector().getByText(fact.content!)).toBeVisible();

  await factRow(other.content).click();
  await expect.element(inspector().getByText(other.content)).toBeVisible();
  await expect.element(draftFooter().getByText("1 selected")).toBeVisible();
  await expect
    .element(page.getByRole("checkbox", { name: `Select for draft: ${fact.content}` }))
    .not.toBeChecked();
  expect(
    useComposerDraftStore.getState().getComposerDraft(target)?.knowledgeContexts ?? [],
  ).toEqual([]);
});

it("edits only after an explicit Edit, and Cancel returns to the fact unchanged", async () => {
  const registry = await setup();
  await using screen = await mount(registry);
  await openMemory(screen);
  await factRow(fact.content!).click();
  await expect.element(page.getByRole("textbox", { name: "Fact content" })).not.toBeInTheDocument();
  const edit = inspector().getByRole("button", { name: "Edit", exact: true });
  await edit.click();
  const content = page.getByRole("textbox", { name: "Fact content" });
  await expect.element(content).toHaveValue(fact.content);
  await expect.element(content).toHaveFocus();
  await content.fill("Unsaved change.");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(content).not.toBeInTheDocument();
  await expect.element(inspector().getByText(fact.content!)).toBeVisible();
  await expect.element(edit).toHaveFocus();
  expect(state.mutate).not.toHaveBeenCalled();

  await edit.click();
  await expect.element(content).toHaveValue(fact.content);
  await content.fill("Cache keys include tenant and region IDs.");
  await page.getByRole("button", { name: "Save edit" }).click();
  expect(state.mutate).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: expect.objectContaining({
      action: "edit",
      factId: fact.id,
      expectedRevision: 1,
      content: "Cache keys include tenant and region IDs.",
    }),
  });
  await expect.element(content).not.toBeInTheDocument();
});

it("moves through facts with the keyboard and selects without changing the inspected fact", async () => {
  const registry = await setup();
  const second = { ...fact, id: ProjectFactId.make("second"), content: "Second fact." };
  const third = { ...fact, id: ProjectFactId.make("third"), content: "Third fact." };
  state.list = Atom.make(AsyncResult.success({ facts: [fact, second, third], nextCursor: null }));
  await using screen = await mount(registry);
  await openMemory(screen);
  (factRow(fact.content!).element() as HTMLElement).focus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(factRow(second.content)).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(inspector().getByText(second.content)).toBeVisible();
  // Desktop keeps focus on the row so browsing can continue.
  await expect.element(factRow(second.content)).toHaveFocus();
  await userEvent.keyboard("{End}");
  await expect.element(factRow(third.content)).toHaveFocus();
  await userEvent.keyboard("{Home}");
  await expect.element(factRow(fact.content!)).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{Tab}");
  const checkbox = page.getByRole("checkbox", { name: `Select for draft: ${second.content}` });
  await expect.element(checkbox).toHaveFocus();
  await userEvent.keyboard(" ");
  await expect.element(checkbox).toBeChecked();
  await expect.element(draftFooter().getByText("1 selected")).toBeVisible();
  await expect.element(inspector().getByText(second.content)).toBeVisible();
});

it("stacks list and inspector on narrow screens and returns focus to the inspected row", async () => {
  const registry = await setup("narrow");
  await using screen = await mount(registry);
  await openMemory(screen);
  await factRow(fact.content!).click();
  await expect.element(inspector().getByRole("heading", { name: /Proposed/ })).toHaveFocus();
  // Hidden columns leave the accessibility tree, so only one of the two is reachable.
  await expect.element(factList()).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Back to list" }).click();
  await expect.element(factRow(fact.content!)).toHaveFocus();
  await expect.element(inspector()).not.toBeInTheDocument();
});

it("shows real score components and sends the viewed revision for feedback", async () => {
  const registry = await setup();
  await using screen = await mount(registry);
  await openMemory(screen);
  await page.getByRole("searchbox", { name: "Search project knowledge" }).fill("tenant cache");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await factRow(fact.content!).click();
  await page.getByText("Why this matched").click();
  await expect.element(page.getByText(/Holographic 0.800/)).toBeVisible();
  await page.getByRole("button", { name: "Helpful", exact: true }).click();
  expect(state.mutate).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: {
      action: "feedback",
      commandId: expect.any(String),
      projectId: scope.projectId,
      factId: fact.id,
      expectedRevision: 1,
      helpful: true,
    },
  });
});

it("forgets a fact only after the permanent-erase warning is confirmed", async () => {
  const registry = await setup();
  await using screen = await mount(registry);
  await openMemory(screen);
  await factRow(fact.content!).click();
  const forget = inspector().getByRole("button", { name: "Forget", exact: true });
  const warning = page.getByRole("alertdialog");

  await forget.click();
  await expect.element(warning.getByText("Forget this fact permanently?")).toBeVisible();
  await expect.element(warning.getByText(/cannot be restored/)).toBeVisible();
  await expect.element(warning.getByText(/supersede it instead/)).toBeVisible();
  await warning.getByRole("button", { name: "Cancel" }).click();
  await expect.element(warning).not.toBeInTheDocument();
  expect(state.mutate).not.toHaveBeenCalled();

  await forget.click();
  await warning.getByRole("button", { name: "Confirm" }).click();
  await vi.waitFor(() =>
    expect(state.mutate).toHaveBeenCalledWith({
      environmentId: scope.environmentId,
      input: {
        action: "forget",
        commandId: expect.any(String),
        projectId: scope.projectId,
        factId: fact.id,
        expectedRevision: 1,
      },
    }),
  );
});

it("hides unsupported memory", async () => {
  const registry = await setup();
  state.config = Atom.make({ environment: { capabilities: {} } });
  await using screen = await mount(registry);
  await expect
    .element(screen.getByRole("button", { name: "Project memory", exact: true }))
    .not.toBeInTheDocument();
});
it("disables writes for a read-only connection", async () => {
  const registry = await setup();
  state.permission = Atom.make(false);
  await using screen = await mount(registry);
  await openMemory(screen);
  await factRow(fact.content!).click();
  await expect.element(page.getByRole("button", { name: "Forget", exact: true })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "New fact" })).toBeDisabled();
  expect(state.mutate).not.toHaveBeenCalled();
});

it("shows a stale source without exposing an old excerpt", async () => {
  const registry = await setup();
  state.source = Atom.make(AsyncResult.success({ state: "unavailable", reason: "changed" }));
  await using screen = await mount(registry);
  await openMemory(screen);
  await factRow(fact.content!).click();
  await page.getByRole("button", { name: "Message evidence" }).click();
  await expect.element(page.getByText("Source unavailable. changed")).toBeVisible();
  await expect.element(page.getByText("Exact canonical evidence.")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Select message for draft" }))
    .not.toBeInTheDocument();
});

it("flags facts whose citations are unavailable before any citation is opened", async () => {
  const registry = await setup();
  const intact = { ...fact, id: ProjectFactId.make("intact"), content: "Intact fact." };
  state.list = Atom.make(
    AsyncResult.success({
      facts: [fact, intact],
      nextCursor: null,
      unavailableSources: [{ factId: fact.id, reason: "deleted" }],
    }),
  );
  await using screen = await mount(registry);
  await openMemory(screen);
  await expect.element(factRow(fact.content!).getByText("Source deleted")).toBeVisible();
  await expect.element(factRow("Intact fact.").getByText(/^Source /)).not.toBeInTheDocument();
  expect(state.readSource).not.toHaveBeenCalled();
});

it("remembers a timeline message with a citation to that exact message", async () => {
  const registry = await setup();
  function RememberEvidence() {
    const open = useOpenProjectMemory();
    return (
      <button
        type="button"
        onClick={() =>
          open({
            environmentId: scope.environmentId,
            projectId: scope.projectId,
            message: { threadId: source.threadId, messageId: source.messageId },
          })
        }
      >
        Remember evidence
      </button>
    );
  }
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <RememberEvidence />
      <ProjectMemoryDialogHost {...scope} composerDraftTarget={target} />
      <ConfirmDialogHost />
    </RegistryContext.Provider>,
  );
  await screen.getByRole("button", { name: "Remember evidence" }).click();
  await expect.element(inspector().getByText("Exact canonical evidence.")).toBeVisible();
  expect(state.readSource).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: {
      projectId: scope.projectId,
      threadId: source.threadId,
      messageId: source.messageId,
      includeArchived: false,
    },
  });
  await page.getByRole("button", { name: "Save as fact" }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Fact content" }))
    .toHaveValue("Exact canonical evidence.");
  await page.getByRole("button", { name: "Save fact", exact: true }).click();
  expect(state.mutate).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: expect.objectContaining({
      action: "create",
      projectId: scope.projectId,
      content: "Exact canonical evidence.",
      sources: [source],
    }),
  });
});

it("does not reattach a selection removed while its preview is pending", async () => {
  const registry = await setup();
  let complete!: (value: unknown) => void;
  state.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await using screen = await mount(registry);
  await openMemory(screen);
  await page.getByRole("checkbox", { name: /Select for draft/ }).click();
  await page.getByRole("button", { name: "Preview and attach" }).click();
  await page.getByRole("button", { name: "Clear selection" }).click();
  await act(async () =>
    complete({
      _tag: "Success",
      value: {
        context: state.prepare.mock.calls[0]![0].input,
        text: "Old selection preview.",
        byteLength: 22,
      },
    }),
  );
  expect(
    useComposerDraftStore.getState().getComposerDraft(target)?.knowledgeContexts ?? [],
  ).toEqual([]);
  await expect.element(page.getByText("Old selection preview.")).not.toBeInTheDocument();
});

it("does not attach after the panel closes and a new panel removes the selection", async () => {
  const registry = await setup();
  let complete!: (value: unknown) => void;
  state.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await using screen = await mount(registry);
  await openMemory(screen);
  await page.getByRole("checkbox", { name: /Select for draft/ }).click();
  await page.getByRole("button", { name: "Preview and attach" }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await openMemory(screen);
  // The pending preview never attached, so the reopened panel starts with no selection.
  await expect.element(draftFooter().getByText("Nothing selected")).toBeVisible();
  await act(async () =>
    complete({
      _tag: "Success",
      value: {
        context: state.prepare.mock.calls[0]![0].input,
        text: "Closed panel preview.",
        byteLength: 21,
      },
    }),
  );
  expect(
    useComposerDraftStore.getState().getComposerDraft(target)?.knowledgeContexts ?? [],
  ).toEqual([]);
  await expect.element(page.getByText("Closed panel preview.")).not.toBeInTheDocument();
});

it("pages facts and conversations independently and resets both for a new query", async () => {
  const registry = await setup();
  const factCursor = { requestId: CommandId.make("ranking"), offset: 1 };
  const messageCursor = {
    query: "tenant cache",
    projectId: scope.projectId,
    includeArchived: false,
    rank: 1 as const,
    updatedAt: fact.updatedAt,
    threadId: scope.threadId,
  };
  const makeResult = (factPage: number, messagePage: number) =>
    Atom.make(
      AsyncResult.success({
        facts: {
          state: "available",
          coverage: "complete",
          nextCursor: factPage === 0 ? factCursor : null,
          matches: [
            {
              fact: {
                ...fact,
                id: ProjectFactId.make(`fact-${factPage}`),
                content: `Fact page ${factPage}`,
              },
            },
          ],
        },
        messages: {
          nextCursor: messagePage === 0 ? messageCursor : null,
          matches: [{ ...source, snippet: `Conversation page ${messagePage}` }],
        },
      }),
    );
  const first = makeResult(0, 0);
  const messages = makeResult(0, 1);
  const both = makeResult(1, 1);
  state.searchRequest.mockImplementation(({ input }: { input: ProjectKnowledgeSearchInput }) =>
    input.factCursor ? both : input.cursor ? messages : first,
  );
  await using screen = await mount(registry);
  await openMemory(screen);
  await page.getByRole("searchbox", { name: "Search project knowledge" }).fill("tenant cache");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.element(page.getByText("Fact page 0", { exact: true })).toBeVisible();
  const firstInput = state.searchRequest.mock.lastCall![0].input;
  expect(firstInput).toEqual({
    projectId: scope.projectId,
    query: "tenant cache",
    includeArchived: false,
    requestId: expect.any(String),
    recordRetrieval: false,
  });
  await page.getByRole("button", { name: "Next conversations" }).click();
  await expect.element(page.getByText("Conversation page 1", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Fact page 0", { exact: true })).toBeVisible();
  expect(state.searchRequest.mock.lastCall![0].input).toEqual({
    ...firstInput,
    cursor: messageCursor,
  });
  await page.getByRole("button", { name: "Next fact matches" }).click();
  await expect.element(page.getByText("Fact page 1", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Conversation page 1", { exact: true })).toBeVisible();
  const factInput = state.searchRequest.mock.lastCall![0].input;
  expect(factInput).toEqual({
    ...firstInput,
    requestId: expect.any(String),
    cursor: messageCursor,
    factCursor,
  });
  expect(factInput.requestId).not.toBe(firstInput.requestId);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.element(page.getByText("Fact page 0", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Conversation page 0", { exact: true })).toBeVisible();
  expect(state.searchRequest.mock.lastCall![0].input.requestId).not.toBe(factInput.requestId);
  await page.getByRole("searchbox", { name: "Search project knowledge" }).fill("new query");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.element(page.getByText("Conversation page 0", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Fact page 0", { exact: true })).toBeVisible();
  expect(state.searchRequest.mock.lastCall![0].input).toEqual({
    projectId: scope.projectId,
    query: "new query",
    includeArchived: false,
    requestId: expect.any(String),
    recordRetrieval: false,
  });
});

it("opens a fact's history as an ordered timeline with its trust trend", async () => {
  const registry = await setup();
  state.detail = Atom.make(
    AsyncResult.success({
      fact: { ...fact, revision: 2, trust: 0.6 },
      sourceUnavailable: "deleted",
      history: [
        historyEntry({
          sequence: 1,
          event: "created",
          revision: 1,
          trustAfter: 0.5,
          actor: fact.origin,
          content: "Cache keys include tenants.",
        }),
        historyEntry({
          sequence: 2,
          event: "edited",
          revision: 2,
          trustBefore: 0.5,
          trustAfter: 0.5,
          content: fact.content,
          sources: [source],
          sourceUnavailable: "deleted",
        }),
        historyEntry({
          sequence: 3,
          event: "feedback",
          revision: 2,
          trustBefore: 0.5,
          trustAfter: 0.6,
          helpful: true,
        }),
      ],
      historyTruncated: true,
      supersedes: null,
      supersededBy: null,
      hints: [],
    }),
  );
  await using screen = await mount(registry);
  await openMemory(screen);
  await factRow(fact.content!).click();
  expect(state.readFact).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: { projectId: scope.projectId, factId: fact.id },
  });
  const rows = page.getByRole("list", { name: "Fact history" }).getByRole("listitem");
  await expect.element(rows.nth(2)).toBeVisible();
  expect(rows.elements().map((row) => row.querySelector("span")?.textContent)).toEqual([
    "Created",
    "Edited to revision 2",
    "Marked helpful",
  ]);
  await expect.element(rows.nth(0).getByText(/Agent observation from Code agent/)).toBeVisible();
  await expect.element(rows.nth(1).getByText("Source deleted")).toBeVisible();
  await expect.element(rows.nth(2).getByText("Trust 0.50 → 0.60")).toBeVisible();
  await expect.element(page.getByText("Earlier history not shown")).toBeVisible();
  await expect
    .element(page.getByRole("img", { name: "Trust from 0.50 to 0.60" }))
    .toBeInTheDocument();
  // The list stays beside the inspector, so the next fact is one click away.
  await expect.element(factRow(fact.content!)).toBeVisible();
});

it("marks superseded facts read-only and filters to facts that lost their source", async () => {
  const registry = await setup();
  const replacement = ProjectFactId.make("replacement-fact-id");
  state.list = Atom.make(
    AsyncResult.success({
      facts: [{ ...fact, status: "confirmed", supersededBy: replacement }],
      nextCursor: null,
    }),
  );
  state.status = Atom.make(AsyncResult.success({ ...healthStatus, unavailableSources: 1 }));
  await using screen = await mount(registry);
  await openMemory(screen);
  await expect.element(factRow(fact.content!).getByText("Superseded by replacem")).toBeVisible();
  await factRow(fact.content!).click();
  await expect.element(inspector().getByText("Superseded by replacem")).toBeVisible();
  await expect
    .element(inspector().getByRole("button", { name: "Edit", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(inspector().getByRole("button", { name: "Supersede", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(inspector().getByRole("button", { name: "Forget", exact: true }))
    .toBeEnabled();
  expect(state.listRequest.mock.lastCall![0].input).not.toHaveProperty("sourceState");
  const lost = page.getByRole("button", { name: "Lost source (1)" });
  await lost.click();
  await expect.element(lost).toHaveAttribute("aria-pressed", "true");
  expect(state.listRequest.mock.lastCall![0].input).toEqual({
    projectId: scope.projectId,
    sourceState: "unavailable",
  });
  await page.getByRole("button", { name: "Confirmed", exact: true }).click();
  await expect.element(lost).toHaveAttribute("aria-pressed", "false");
  expect(state.listRequest.mock.lastCall![0].input).not.toHaveProperty("sourceState");
});

it("supersedes a fact and surfaces the conflict hints the server returns", async () => {
  const registry = await setup();
  state.mutate.mockResolvedValue({
    _tag: "Success",
    value: {
      ...fact,
      id: ProjectFactId.make("replacement"),
      content: "Cache keys include tenant and region IDs.",
      supersedes: fact.id,
      hints: [
        {
          kind: "possible_conflict",
          factId: ProjectFactId.make("other"),
          revision: 3,
          excerpt: "Cache keys never include region.",
          similarity: 0.7,
        },
      ],
    },
  });
  await using screen = await mount(registry);
  await openMemory(screen);
  await factRow(fact.content!).click();
  await page.getByRole("button", { name: "Supersede", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Fact content" }))
    .toHaveValue(fact.content);
  await page
    .getByRole("textbox", { name: "Fact content" })
    .fill("Cache keys include tenant and region IDs.");
  await page.getByRole("button", { name: "Save replacement" }).click();
  expect(state.mutate).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: expect.objectContaining({
      action: "supersede",
      factId: fact.id,
      expectedRevision: 1,
      replacementFactId: expect.any(String),
      content: "Cache keys include tenant and region IDs.",
    }),
  });
  const notice = page.getByRole("region", { name: "Possible conflicts" });
  await expect.element(notice.getByText(/Possible conflict with/)).toBeVisible();
  await notice.getByRole("button", { name: "Compare" }).click();
  await expect.element(notice.getByText("This fact")).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect.element(notice).not.toBeInTheDocument();
});

it("reviews assisted suggestions with their citations and controls the project opt-in", async () => {
  const registry = await setup();
  const runId = RunId.make("run");
  const suggestion: ProjectFact = {
    ...fact,
    id: ProjectFactId.make("assisted:run:0"),
    origin: { kind: "assisted", threadId: scope.threadId, runId, runOutcome: "failed" },
    content: "Cache keys include tenant and region IDs.",
    supersedes: ProjectFactId.make("existing-fact"),
  };
  state.config = Atom.make({
    environment: {
      capabilities: {
        projectKnowledge: true,
        projectKnowledgeHistory: true,
        projectKnowledgeAssistedLearning: true,
        projectSettingsOverrides: true,
      },
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [scope.projectId]: { defaultAutoPull: true, enableAssistedLearning: true },
      },
    },
  });
  state.status = Atom.make(
    AsyncResult.success({
      ...healthStatus,
      assistedLearning: {
        suggested: 1,
        lastRun: {
          threadId: scope.threadId,
          runId,
          runOutcome: "failed",
          result: "ran",
          reason: null,
          proposed: 1,
          suggested: 1,
          at: fact.createdAt,
        },
      },
    } satisfies ProjectKnowledgeStatus),
  );
  state.list = Atom.make(AsyncResult.success({ facts: [suggestion], nextCursor: null }));
  await using screen = await mount(registry);
  await openMemory(screen);
  await page.getByRole("button", { name: "Memory health" }).click();
  const optIn = page.getByRole("switch", { name: "Suggest facts from finished runs" });
  await expect.element(optIn).toBeChecked();
  await expect
    .element(page.getByText("Last run: proposed 1 (1 as updates to existing facts)."))
    .toBeVisible();

  await page.getByRole("button", { name: "Suggested (1)" }).click();
  expect(state.listRequest).toHaveBeenLastCalledWith({
    environmentId: scope.environmentId,
    input: { projectId: scope.projectId, status: "proposed", origin: "assisted" },
  });
  const row = factRow(suggestion.content!);
  await expect.element(row.getByText("Suggested", { exact: true })).toBeVisible();
  await row.click();
  await expect.element(inspector().getByText("Suggested from a run that failed")).toBeVisible();
  await expect.element(inspector().getByText("Would replace existing")).toBeVisible();
  await inspector().getByRole("button", { name: "Message evidence" }).click();
  await expect.element(page.getByText("Exact canonical evidence.")).toBeVisible();
  await page.getByRole("button", { name: "Back to fact" }).click();
  await inspector().getByRole("button", { name: "Confirm", exact: true }).click();
  expect(state.mutate).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: {
      action: "confirm",
      commandId: expect.any(String),
      projectId: scope.projectId,
      factId: suggestion.id,
      expectedRevision: 1,
    },
  });

  await optIn.click();
  // Other overrides for the project survive the write, which replaces the whole entry.
  expect(state.updateSettings).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: {
      patch: {
        projectSettingsOverrides: {
          [scope.projectId]: { defaultAutoPull: true, enableAssistedLearning: false },
        },
      },
    },
  });
});
