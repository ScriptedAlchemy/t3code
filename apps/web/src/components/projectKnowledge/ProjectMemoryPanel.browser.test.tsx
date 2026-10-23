import "../../index.css";
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProjectFactId,
  MessageId,
  type ProjectFact,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  config: null as unknown,
  permission: null as unknown,
  list: null as unknown,
  search: null as unknown,
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
        search: () => state.search,
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
import { ProjectMemoryPanel } from "./ProjectMemoryPanel";

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
let registry: ReturnType<typeof AtomRegistry.make>;

beforeEach(() => {
  registry = AtomRegistry.make();
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
  useComposerDraftStore.getState().clearComposerContent(target);
});

async function mount() {
  return render(
    <RegistryContext.Provider value={registry}>
      <ProjectMemoryPanel {...scope} />
    </RegistryContext.Provider>,
  );
}

it("opens exact evidence and attaches only references, then removes the attachment", async () => {
  await using screen = await mount();
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
  await using screen = await mount();
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
  state.config = Atom.make({ environment: { capabilities: {} } });
  await using screen = await mount();
  await expect
    .element(screen.getByRole("button", { name: "Project memory", exact: true }))
    .not.toBeInTheDocument();
});
it("disables writes for a read-only connection", async () => {
  state.permission = Atom.make(false);
  await using screen = await mount();
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Forget", exact: true })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
  expect(state.mutate).not.toHaveBeenCalled();
});

it("shows a stale source without exposing an old excerpt", async () => {
  state.source = Atom.make(AsyncResult.success({ state: "unavailable", reason: "changed" }));
  await using screen = await mount();
  await screen.getByRole("button", { name: "Project memory", exact: true }).click();
  await page.getByRole("button", { name: "Message evidence" }).click();
  await expect.element(page.getByText("Source unavailable. changed")).toBeVisible();
  await expect.element(page.getByText("Exact canonical evidence.")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Select message" }))
    .not.toBeInTheDocument();
});

it("does not reattach a selection removed while its preview is pending", async () => {
  let complete!: (value: unknown) => void;
  state.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await using screen = await mount();
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
