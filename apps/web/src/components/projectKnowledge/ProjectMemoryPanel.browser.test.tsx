import "../../index.css";
import { RegistryContext } from "@effect/atom-react";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProjectFactId,
  MessageId,
  type ProjectFact,
  type ProjectKnowledgeSearchInput,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  config: null as unknown,
  permission: null as unknown,
  list: null as unknown,
  search: null as unknown,
  searchRequest: vi.fn(),
  source: null as unknown,
  prepare: vi.fn(),
  mutate: vi.fn(),
  readSource: vi.fn(),
}));
vi.mock(
  import("../../state/server"),
  () => ({ serverEnvironment: { configValueAtom: () => state.config } }) as never,
);
vi.mock(
  import("../../state/projectKnowledge"),
  () =>
    ({
      projectKnowledge: {
        list: () => state.list,
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
        command.label === "prepare" ? state.prepare : state.mutate,
    }) as never,
);

import { useComposerDraftStore, partializeComposerDraftStoreState } from "../../composerDraftStore";
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
function setup() {
  const registry = AtomRegistry.make();
  state.config = Atom.make({ environment: { capabilities: { projectKnowledge: true } } });
  state.permission = Atom.make(true);
  state.list = Atom.make(AsyncResult.success({ facts: [fact], nextCursor: null }));
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
  state.searchRequest.mockReset().mockImplementation(() => state.search);
  useComposerDraftStore.getState().clearComposerContent(target);
  return registry;
}

async function mount(registry: ReturnType<typeof AtomRegistry.make>) {
  return render(
    <RegistryContext.Provider value={registry}>
      <ProjectMemoryPanel environmentId={scope.environmentId} projectId={scope.projectId} />
      <ProjectMemoryDialogHost {...scope} />
    </RegistryContext.Provider>,
  );
}

it("opens exact evidence and attaches only references, then removes the attachment", async () => {
  const registry = setup();
  await using screen = await mount(registry);
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
  await page.getByRole("button", { name: "Message evidence" }).click();
  await expect.element(page.getByText("Exact canonical evidence.")).toBeVisible();
  expect(state.readSource).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: { projectId: scope.projectId, ...source, includeArchived: false },
  });
  await page.getByRole("button", { name: "Select", exact: true }).click();
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
  await page.getByRole("button", { name: "Remove attachment" }).click();
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.knowledgeContexts).toEqual([]);
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).not.toContain(
    "t3-context",
  );
});

it("shows real score components and sends the viewed revision for feedback", async () => {
  const registry = setup();
  await using screen = await mount(registry);
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
  await page.getByRole("textbox", { name: "Search project knowledge" }).fill("tenant cache");
  await page.getByRole("button", { name: "Search", exact: true }).click();
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

it("hides unsupported memory", async () => {
  const registry = setup();
  state.config = Atom.make({ environment: { capabilities: {} } });
  await using screen = await mount(registry);
  await expect
    .element(screen.getByRole("button", { name: "Project memory", exact: true }))
    .not.toBeInTheDocument();
});
it("disables writes for a read-only connection", async () => {
  const registry = setup();
  state.permission = Atom.make(false);
  await using screen = await mount(registry);
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Forget", exact: true })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
  expect(state.mutate).not.toHaveBeenCalled();
});

it("shows a stale source without exposing an old excerpt", async () => {
  const registry = setup();
  state.source = Atom.make(AsyncResult.success({ state: "unavailable", reason: "changed" }));
  await using screen = await mount(registry);
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
  await page.getByRole("button", { name: "Message evidence" }).click();
  await expect.element(page.getByText("Source unavailable. changed")).toBeVisible();
  await expect.element(page.getByText("Exact canonical evidence.")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Select message" }))
    .not.toBeInTheDocument();
});

it("flags facts whose citations are unavailable before any citation is opened", async () => {
  const registry = setup();
  const intact = { ...fact, id: ProjectFactId.make("intact"), content: "Intact fact." };
  state.list = Atom.make(
    AsyncResult.success({
      facts: [fact, intact],
      nextCursor: null,
      unavailableSources: [{ factId: fact.id, reason: "deleted" }],
    }),
  );
  await using screen = await mount(registry);
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
  const flagged = page.getByRole("article").filter({ hasText: fact.content! });
  await expect.element(flagged.getByText("Source deleted")).toBeVisible();
  const clean = page.getByRole("article").filter({ hasText: "Intact fact." });
  await expect.element(clean.getByText(/^Source /)).not.toBeInTheDocument();
  expect(state.readSource).not.toHaveBeenCalled();
});

it("remembers a timeline message with a citation to that exact message", async () => {
  const registry = setup();
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
      <ProjectMemoryDialogHost {...scope} />
    </RegistryContext.Provider>,
  );
  await screen.getByRole("button", { name: "Remember evidence" }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Fact content" }))
    .toHaveValue("Exact canonical evidence.");
  expect(state.readSource).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: {
      projectId: scope.projectId,
      threadId: source.threadId,
      messageId: source.messageId,
      includeArchived: false,
    },
  });
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
  const registry = setup();
  let complete!: (value: unknown) => void;
  state.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await using screen = await mount(registry);
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Preview and attach" }).click();
  await page.getByRole("button", { name: "Remove attachment" }).click();
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
  const registry = setup();
  let complete!: (value: unknown) => void;
  state.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await using screen = await mount(registry);
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Preview and attach" }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
  await page.getByRole("button", { name: "Remove attachment" }).click();
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
  const registry = setup();
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
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
  await page.getByRole("textbox", { name: "Search project knowledge" }).fill("tenant cache");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.element(page.getByText("Fact page 0", { exact: true })).toBeVisible();
  const firstInput = state.searchRequest.mock.lastCall![0].input;
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
  await page.getByRole("textbox", { name: "Search project knowledge" }).fill("new query");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.element(page.getByText("Conversation page 0", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Fact page 0", { exact: true })).toBeVisible();
  expect(state.searchRequest.mock.lastCall![0].input).toEqual({
    projectId: scope.projectId,
    query: "new query",
    includeArchived: false,
    requestId: expect.any(String),
  });
});
