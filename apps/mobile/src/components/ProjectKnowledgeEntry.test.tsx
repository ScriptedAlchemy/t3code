import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProjectFactId,
  ThreadId,
  type ProjectFact,
  type ProjectKnowledgeSearchInput,
} from "@t3tools/contracts";
import { projectKnowledgeComposerReference } from "../lib/projectKnowledgeComposer";

const state = vi.hoisted(() => ({
  draft: {} as { text: string; context?: { records: unknown[] } },
  list: null as unknown,
  search: null as unknown,
  source: null as unknown,
  searchRequest: vi.fn(),
  prepare: vi.fn(),
  mutate: vi.fn(),
  insert: vi.fn(),
  setText: vi.fn(),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => new Error("Request failed"),
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => crypto.randomUUID() }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Switch: ({
    value,
    onValueChange,
  }: {
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      aria-label="Include archived conversations"
      type="checkbox"
      checked={value}
      onChange={(event) => onValueChange(event.target.checked)}
    />
  ),
}));
vi.mock("./ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (text: string) => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onInput={(event) => onChangeText(event.currentTarget.value)}
    />
  ),
}));
vi.mock("./ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));
vi.mock("./ui/Sheet", () => ({
  Sheet: ({ children, onClose }: { children: ReactNode; onClose: () => void }) => (
    <div>
      <button onClick={onClose}>Close</button>
      {children}
    </div>
  ),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => ({ environment: { capabilities: { projectKnowledge: true } } }),
  },
}));
vi.mock("../state/projectKnowledge", () => ({
  projectKnowledge: {
    list: () => state.list,
    search: (request: unknown) => {
      return state.searchRequest(request);
    },
    readSource: () => state.source,
    prepareContext: "prepare",
    mutate: { permissionAtom: () => true },
  },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (data: unknown) => ({
    data,
    error: null,
    isPending: false,
    refresh: () => {},
  }),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "prepare" ? state.prepare : state.mutate),
}));
vi.mock("../state/use-composer-drafts", () => ({
  useComposerDraft: () => state.draft,
  getComposerDraftSnapshot: () => state.draft,
  insertComposerDraftContext: (...args: unknown[]) => state.insert(...args),
  setComposerDraftText: (...args: unknown[]) => state.setText(...args),
}));
import { ProjectKnowledgeEntry, requestRememberMessage } from "./ProjectKnowledgeEntry";

const scope = {
  environmentId: EnvironmentId.make("mobile-memory"),
  projectId: ProjectId.make("project"),
  draftKey: "draft",
  disabled: false,
};
const fact: ProjectFact = {
  id: ProjectFactId.make("fact"),
  projectId: scope.projectId,
  origin: { kind: "agent-client", sessionId: "agent", label: "Agent" },
  content: "Cache keys include tenant IDs.",
  entities: [],
  tags: [],
  kind: "note",
  sources: [],
  status: "proposed",
  revision: 1,
  trust: 0.5,
  retrievalCount: 0,
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
  forgottenAt: null,
};
function setup() {
  state.draft = { text: "" };
  state.list = { facts: [fact], nextCursor: null };
  state.source = null;
  state.search = {
    messages: { matches: [], nextCursor: null },
    facts: { state: "available", matches: [], coverage: "complete", nextCursor: null },
  };
  state.searchRequest.mockReset().mockImplementation(() => state.search);
  state.prepare.mockReset().mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: { context: input, text: "Prepared evidence", byteLength: 17 },
  }));
  state.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: { ...fact, revision: 2 } });
  state.insert.mockReset().mockReturnValue(true);
  state.setText.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<ProjectKnowledgeEntry {...scope} />));
  return {
    container,
    click: async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === label,
      );
      expect(button, label).toBeDefined();
      await act(async () => button!.click());
    },
    unmount: () => act(() => root.unmount()),
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

it.each(["selection", "archive", "close", "unmount", "removal"] as const)(
  "ignores a pending attachment after %s",
  async (change) => {
    using screen = setup();
    if (change === "removal") {
      const reference = projectKnowledgeComposerReference({
        ...scope,
        selections: [{ kind: "fact", factId: fact.id, revision: 1 }],
        maxBytes: 48_000,
      });
      state.draft = { text: reference.text, context: { records: [reference.record] } };
    }
    let complete!: (value: unknown) => void;
    state.prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await screen.click("Project memory");
    if (change !== "removal") await screen.click("Select");
    await screen.click("Attach to draft");
    if (change === "selection") await screen.click("Selected");
    if (change === "archive")
      await act(async () =>
        (screen.container.querySelector('[type="checkbox"]') as HTMLInputElement).click(),
      );
    if (change === "close") {
      await screen.click("Close");
      await screen.click("Project memory");
    }
    if (change === "unmount") screen.unmount();
    if (change === "removal") await screen.click("Remove from draft");
    await act(async () =>
      complete({
        _tag: "Success",
        value: {
          context: state.prepare.mock.calls[0]![0].input,
          text: "Old evidence",
          byteLength: 12,
        },
      }),
    );
    expect(state.insert).not.toHaveBeenCalled();
  },
);

it("flags a fact whose citation is unavailable in the list", async () => {
  using screen = setup();
  state.list = {
    facts: [fact],
    nextCursor: null,
    unavailableSources: [{ factId: fact.id, reason: "changed" }],
  };
  await screen.click("Project memory");
  expect(screen.container.textContent).toContain("Source changed");
});

it("saves a remembered feed message with a citation to that message", async () => {
  using screen = setup();
  const source = {
    kind: "message" as const,
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    digest: "b".repeat(64),
  };
  state.source = {
    state: "available",
    source,
    text: "Use tenant IDs in cache keys.",
    title: "Thread",
    role: "assistant",
    createdAt: fact.createdAt,
    archived: false,
  };
  act(() =>
    requestRememberMessage({
      environmentId: scope.environmentId,
      projectId: scope.projectId,
      message: { threadId: source.threadId, messageId: source.messageId },
    }),
  );
  expect(
    (screen.container.querySelector('[aria-label="Fact content"]') as HTMLInputElement).value,
  ).toBe("Use tenant IDs in cache keys.");
  await screen.click("Save");
  expect(state.mutate).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: expect.objectContaining({
      action: "create",
      content: "Use tenant IDs in cache keys.",
      sources: [source],
    }),
  });
});

it("attaches the current selection", async () => {
  using screen = setup();
  await screen.click("Project memory");
  await screen.click("Select");
  await screen.click("Attach to draft");
  expect(state.insert).toHaveBeenCalledWith(
    scope.draftKey,
    expect.objectContaining({
      record: expect.objectContaining({
        knowledge: expect.objectContaining({
          selections: [{ kind: "fact", factId: fact.id, revision: 1 }],
        }),
      }),
    }),
  );
});

it("edits a citationless agent observation as an explicit user assertion", async () => {
  using screen = setup();
  await screen.click("Project memory");
  await screen.click("Edit");
  await screen.click("Save");
  expect(state.mutate).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: expect.objectContaining({
      action: "edit",
      factId: fact.id,
      expectedRevision: 1,
      sources: [{ kind: "user" }],
    }),
  });
});

it("pages both result streams without restarting the other stream", async () => {
  using screen = setup();
  const factCursor = { requestId: CommandId.make("ranking"), offset: 1 };
  const messageCursor = {
    query: "tenant cache",
    projectId: scope.projectId,
    includeArchived: false,
    rank: 1,
    updatedAt: fact.updatedAt,
    threadId: "conversation-0",
  };
  state.searchRequest.mockImplementation(({ input }: { input: ProjectKnowledgeSearchInput }) => ({
    facts: {
      state: "available",
      coverage: "complete",
      nextCursor: input.factCursor ? null : factCursor,
      matches: [{ fact: { ...fact, content: input.factCursor ? "Second fact" : "First fact" } }],
    },
    messages: {
      nextCursor: input.cursor ? null : messageCursor,
      matches: [
        {
          threadId: "conversation",
          messageId: "message",
          digest: "a".repeat(64),
          snippet: input.cursor ? "Second conversation" : "First conversation",
        },
      ],
    },
  }));
  await screen.click("Project memory");
  const input = screen.container.querySelector(
    '[aria-label="Search project knowledge"]',
  ) as HTMLInputElement;
  await act(async () => {
    input.value = "tenant cache";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await screen.click("Search");
  expect(screen.container.textContent).toContain("First fact");
  const firstInput = state.searchRequest.mock.lastCall![0].input;
  await screen.click("Next conversations");
  expect(screen.container.textContent).toContain("Second conversation");
  expect(screen.container.textContent).toContain("First fact");
  expect(state.searchRequest.mock.lastCall![0].input).toEqual({
    ...firstInput,
    cursor: messageCursor,
  });
  await screen.click("Next fact matches");
  expect(screen.container.textContent).toContain("Second fact");
  expect(screen.container.textContent).toContain("Second conversation");
  const factInput = state.searchRequest.mock.lastCall![0].input;
  expect(factInput).toEqual({
    ...firstInput,
    requestId: expect.any(String),
    cursor: messageCursor,
    factCursor,
  });
  expect(factInput.requestId).not.toBe(firstInput.requestId);
  await screen.click("Refresh");
  expect(screen.container.textContent).toContain("First fact");
  expect(screen.container.textContent).toContain("First conversation");
  expect(state.searchRequest.mock.lastCall![0].input.requestId).not.toBe(factInput.requestId);
  await act(async () => {
    input.value = "new query";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await screen.click("Search");
  expect(screen.container.textContent).toContain("First fact");
  expect(screen.container.textContent).toContain("First conversation");
  expect(state.searchRequest.mock.lastCall![0].input).toEqual({
    projectId: scope.projectId,
    query: "new query",
    includeArchived: false,
    requestId: expect.any(String),
  });
});
