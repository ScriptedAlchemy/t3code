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
  listInputs: [] as unknown[],
  search: null as unknown,
  source: null as unknown,
  searchRequest: vi.fn(),
  prepare: vi.fn(),
  mutate: vi.fn(),
  insert: vi.fn(),
  setText: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => new Error("Request failed"),
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => crypto.randomUUID() }));
vi.mock("../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("react-native", () => ({
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityLabel: string;
    onPress: () => void;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  Switch: ({
    accessibilityLabel,
    value,
    onValueChange,
  }: {
    accessibilityLabel?: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      aria-label={accessibilityLabel ?? "Include archived conversations"}
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
vi.mock("./ui/Dialog", () => ({ confirm: (request: unknown) => state.confirm(request) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => ({
      environment: { capabilities: { projectKnowledge: true, projectKnowledgeHistory: true } },
    }),
  },
}));
vi.mock("../state/projectKnowledge", () => ({
  projectKnowledge: {
    list: (request: { input: unknown }) => {
      state.listInputs.push(request.input);
      return state.list;
    },
    readFact: () => null,
    status: () => null,
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
  state.listInputs = [];
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
  state.confirm.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<ProjectKnowledgeEntry {...scope} />));
  return {
    container,
    click: async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === label || item.getAttribute("aria-label") === label,
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
    if (change !== "removal") await screen.click("Select for draft");
    await screen.click("Attach to draft");
    if (change === "selection") await screen.click("Selected for draft");
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
  await screen.click("Select for draft");
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
  await screen.click(`Inspect fact: ${fact.content}`);
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
  expect(firstInput).toEqual({
    projectId: scope.projectId,
    query: "tenant cache",
    includeArchived: false,
    requestId: expect.any(String),
    recordRetrieval: false,
  });
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
    recordRetrieval: false,
  });
});

it.each([
  ["Helpful", true],
  ["Unhelpful", false],
] as const)("sends %s feedback against the fact's revision", async (label, helpful) => {
  using screen = setup();
  state.list = { facts: [{ ...fact, revision: 3 }], nextCursor: null };
  await screen.click("Project memory");
  await screen.click(`Inspect fact: ${fact.content}`);
  await screen.click(label);
  expect(state.mutate).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: {
      action: "feedback",
      commandId: expect.any(String),
      projectId: scope.projectId,
      factId: fact.id,
      expectedRevision: 3,
      helpful,
    },
  });
});

it("forgets a fact only after the permanent-erase warning is confirmed", async () => {
  using screen = setup();
  await screen.click("Project memory");
  await screen.click(`Inspect fact: ${fact.content}`);

  await screen.click("Forget");
  expect(state.confirm).toHaveBeenCalledTimes(1);
  const warning = state.confirm.mock.lastCall![0];
  expect(warning).toMatchObject({
    title: "Forget this fact permanently?",
    confirmText: "Forget",
    destructive: true,
  });
  expect(warning.message).toContain("cannot be restored");
  expect(warning.message).toContain("supersede it instead");
  // Dismissing the alert runs neither callback, so nothing is sent.
  expect(state.mutate).not.toHaveBeenCalled();

  await act(async () => warning.onConfirm());
  expect(state.mutate).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: {
      action: "forget",
      commandId: expect.any(String),
      projectId: scope.projectId,
      factId: fact.id,
      expectedRevision: 1,
    },
  });
});

it("marks a superseded fact read-only and lists superseded facts on request", async () => {
  using screen = setup();
  state.list = {
    facts: [{ ...fact, supersededBy: ProjectFactId.make("replacement") }],
    nextCursor: null,
  };
  await screen.click("Project memory");
  expect(screen.container.textContent).toContain("Superseded");
  await screen.click(`Inspect fact: ${fact.content}`);
  const labels = [...screen.container.querySelectorAll("button")].map((item) => item.textContent);
  expect(labels).not.toContain("Edit");
  expect(labels).not.toContain("Confirm");
  expect(labels).not.toContain("Supersede");
  await screen.click("Back");
  expect(state.listInputs.at(-1)).not.toHaveProperty("includeSuperseded");
  await act(async () =>
    (
      screen.container.querySelector('[aria-label="Show superseded facts"]') as HTMLInputElement
    ).click(),
  );
  expect(state.listInputs.at(-1)).toMatchObject({ includeSuperseded: true });
});

it("supersedes a fact with a new replacement and shows the returned conflict hints", async () => {
  using screen = setup();
  const conflicting = ProjectFactId.make("conflicting");
  state.mutate.mockResolvedValue({
    _tag: "Success",
    value: {
      ...fact,
      id: ProjectFactId.make("replacement"),
      hints: [
        {
          kind: "possible_conflict",
          factId: conflicting,
          revision: 2,
          excerpt: "Cache keys omit tenant IDs.",
          similarity: 0.7,
        },
      ],
    },
  });
  await screen.click("Project memory");
  await screen.click(`Inspect fact: ${fact.content}`);
  await screen.click("Supersede");
  await screen.click("Save");
  const input = state.mutate.mock.lastCall![0].input;
  expect(input).toMatchObject({
    action: "supersede",
    factId: fact.id,
    expectedRevision: 1,
    content: fact.content,
    sources: [{ kind: "user" }],
  });
  expect(input.replacementFactId).not.toBe(fact.id);
  expect(screen.container.textContent).toContain(
    "Possible conflict with: “Cache keys omit tenant IDs.”",
  );
});

it("treats a changed message source as the same selection and shows it as changed", async () => {
  using screen = setup();
  const match = (digest: string) => ({
    messages: {
      nextCursor: null,
      matches: [{ threadId: "conversation", messageId: "message", digest, snippet: "Tenant" }],
    },
    facts: { state: "available", matches: [], coverage: "complete", nextCursor: null },
  });
  state.search = match("a".repeat(64));
  await screen.click("Project memory");
  const input = screen.container.querySelector(
    '[aria-label="Search project knowledge"]',
  ) as HTMLInputElement;
  await act(async () => {
    input.value = "tenant";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await screen.click("Search");
  await screen.click("Select for draft");
  state.search = match("b".repeat(64));
  await screen.click("Refresh");
  expect(screen.container.textContent).toContain("Source changed");
  expect(screen.container.textContent).toContain(
    "1 selected · up to 20 · 1 changed since selected",
  );
  await screen.click("Selected for draft");
  expect(screen.container.textContent).not.toContain("selected · up to 20");
  await screen.click("Select for draft");
  await screen.click("Attach to draft");
  expect(state.prepare.mock.lastCall![0].input.selections).toEqual([
    {
      kind: "message",
      threadId: "conversation",
      messageId: "message",
      digest: "b".repeat(64),
    },
  ]);
});

it("replaces a changed source with its current version on request", async () => {
  using screen = setup();
  state.search = {
    messages: {
      nextCursor: null,
      matches: [
        { threadId: "conversation", messageId: "message", digest: "b".repeat(64), snippet: "T" },
      ],
    },
    facts: { state: "available", matches: [], coverage: "complete", nextCursor: null },
  };
  const stale = {
    kind: "message" as const,
    threadId: ThreadId.make("conversation"),
    messageId: MessageId.make("message"),
    digest: "a".repeat(64),
  };
  const reference = projectKnowledgeComposerReference({
    ...scope,
    selections: [stale],
    maxBytes: 48_000,
  });
  state.draft = { text: reference.text, context: { records: [reference.record] } };
  await screen.click("Project memory");
  const input = screen.container.querySelector(
    '[aria-label="Search project knowledge"]',
  ) as HTMLInputElement;
  await act(async () => {
    input.value = "tenant";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await screen.click("Search");
  await screen.click("Use current version");
  expect(screen.container.textContent).not.toContain("Source changed");
  await screen.click("Attach to draft");
  expect(state.prepare.mock.lastCall![0].input.selections).toEqual([
    { ...stale, digest: "b".repeat(64) },
  ]);
});

it("removes the attached draft reference when the selection changes and says so", async () => {
  using screen = setup();
  const reference = projectKnowledgeComposerReference({
    ...scope,
    selections: [{ kind: "fact", factId: fact.id, revision: 1 }],
    maxBytes: 48_000,
  });
  state.draft = { text: `See ${reference.text}`, context: { records: [reference.record] } };
  state.setText.mockImplementation((_key: string, text: string) => {
    state.draft = { text };
  });
  await screen.click("Project memory");
  expect(screen.container.textContent).toContain("is attached to this draft");
  await screen.click("Selected for draft");
  expect(state.setText).toHaveBeenCalledWith(scope.draftKey, "See");
  expect(screen.container.textContent).toContain("removed from the draft");
});

it("drops a revised fact from the selection and the draft after saving", async () => {
  using screen = setup();
  const reference = projectKnowledgeComposerReference({
    ...scope,
    selections: [{ kind: "fact", factId: fact.id, revision: 1 }],
    maxBytes: 48_000,
  });
  state.draft = { text: reference.text, context: { records: [reference.record] } };
  state.setText.mockImplementation((_key: string, text: string) => {
    state.draft = { text };
  });
  await screen.click("Project memory");
  await screen.click(`Inspect fact: ${fact.content}`);
  await screen.click("Confirm");
  expect(state.setText).toHaveBeenCalledWith(scope.draftKey, "");
  expect(screen.container.textContent).toContain("0 selected");
  expect(screen.container.textContent).toContain("removed from the draft");
});
