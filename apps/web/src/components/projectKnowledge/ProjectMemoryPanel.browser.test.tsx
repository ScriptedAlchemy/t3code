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
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";

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
function setup() {
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

it("opens a fact's history as an ordered timeline with its trust trend", async () => {
  const registry = setup();
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
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
  await page.getByRole("button", { name: "Details", exact: true }).click();
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
  await page.getByRole("button", { name: "Back to facts" }).click();
  await expect.element(page.getByRole("article")).toBeVisible();
});

it("marks superseded facts read-only and filters to facts that lost their source", async () => {
  const registry = setup();
  const replacement = ProjectFactId.make("replacement-fact-id");
  state.list = Atom.make(
    AsyncResult.success({
      facts: [{ ...fact, status: "confirmed", supersededBy: replacement }],
      nextCursor: null,
    }),
  );
  state.status = Atom.make(AsyncResult.success({ ...healthStatus, unavailableSources: 1 }));
  await using screen = await mount(registry);
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
  const card = page.getByRole("article");
  await expect.element(card.getByText("Superseded by replacem")).toBeVisible();
  await expect
    .element(card.getByRole("button", { name: "Edit", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(card.getByRole("button", { name: "Supersede", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(card.getByRole("button", { name: "Forget", exact: true })).toBeEnabled();
  expect(state.listRequest.mock.lastCall![0].input).not.toHaveProperty("sourceState");
  await page.getByRole("button", { name: "1 fact lost its source" }).click();
  await expect.element(page.getByText("Showing facts that lost their source.")).toBeVisible();
  expect(state.listRequest.mock.lastCall![0].input).toEqual({
    projectId: scope.projectId,
    sourceState: "unavailable",
  });
  await page.getByRole("button", { name: "Show all facts" }).click();
  await expect
    .element(page.getByText("Showing facts that lost their source."))
    .not.toBeInTheDocument();
  expect(state.listRequest.mock.lastCall![0].input).not.toHaveProperty("sourceState");
});

it("supersedes a fact and surfaces the conflict hints the server returns", async () => {
  const registry = setup();
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
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
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
  const registry = setup();
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
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
  const optIn = page.getByRole("checkbox", { name: "Suggest facts from finished runs" });
  await expect.element(optIn).toBeChecked();
  await expect
    .element(page.getByText("Last run: proposed 1 (1 as updates to existing facts)."))
    .toBeVisible();

  await page.getByRole("button", { name: "suggested (1)" }).click();
  expect(state.listRequest).toHaveBeenLastCalledWith({
    environmentId: scope.environmentId,
    input: { projectId: scope.projectId, status: "proposed", origin: "assisted" },
  });
  const card = page.getByRole("article").filter({ hasText: suggestion.content! });
  await expect.element(card.getByText("Suggested from a run that failed")).toBeVisible();
  await expect.element(card.getByText("Would replace existing")).toBeVisible();
  await card.getByRole("button", { name: "Message evidence" }).click();
  await expect.element(page.getByText("Exact canonical evidence.")).toBeVisible();
  await card.getByRole("button", { name: "Confirm", exact: true }).click();
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
