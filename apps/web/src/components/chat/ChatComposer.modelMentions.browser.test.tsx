import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { Editor } from "@tiptap/core";
import { createRef, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { makeThreadFixture } from "../../test-fixtures";
import { ChatComposer, type ChatComposerHandle, type ChatComposerProps } from "./ChatComposer";
import { useComposerSelection } from "./useComposerSelection";

vi.mock("../../state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make(null) };
});

vi.mock("./ComposerCommandMenuLayer", () => ({
  ComposerCommandMenuLayer: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("./ComposerControlsBar", () => ({ ComposerControlsBar: () => null }));
vi.mock("./ComposerFooterControls", () => ({ ComposerFooterPrimaryActions: () => null }));
vi.mock("./useProviderWorkspaceSnapshotRefresh", () => ({
  useProviderWorkspaceSnapshotRefresh: () => () => {},
}));
vi.mock("./useComposerMenuItems", () => ({
  useComposerMenuItems: () => ({
    items: [
      {
        id: "model:codex:gpt-5.4",
        type: "model",
        instanceId: "codex",
        model: "gpt-5.4",
        driverKind: "codex",
        providerDisplayName: "Codex",
        label: "GPT-5.4",
        description: "Codex",
      },
    ],
    isLoading: false,
    emptyState: "",
  }),
}));

function setup() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
  const thread = makeThreadFixture();
  const target = { environmentId: thread.environmentId, threadId: thread.id };
  useComposerDraftStore.getState().setPrompt(target, "before  after");
  const composerRef = createRef<ChatComposerHandle>();
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  };
  const focusComposer = () => composerRef.current?.focusAtEnd();
  // ChatView schedules focusAtEnd after a provider selection.
  const scheduleComposerFocus = vi.fn(() => window.requestAnimationFrame(focusComposer));
  const noop = () => {};
  const props: ChatComposerProps = {
    composerDraftTarget: target,
    environmentId: thread.environmentId,
    canOperateThread: true,
    attachmentUploadsCapabilityKnown: false,
    supportsAttachmentUploads: false,
    supportsQuestionAttachments: false,
    maxFileAttachmentBytes: null,
    routeKind: "server",
    routeThreadRef: target,
    draftId: null,
    multipleModelSelections: null,
    supportsMultipleModels: false,
    onMultipleModelSelectionsChange: noop,
    activeThreadId: thread.id,
    activeThread: thread,
    activeThreadShell: null,
    promptHistoryMessages: [],
    forceExpandedOnMobile: false,
    projectSelectionRequired: false,
    phase: "ready",
    canInterrupt: false,
    isSendBusy: false,
    canResume: false,
    sendDisabledReason: null,
    isPreparingWorktree: false,
    isCompacting: false,
    bannerItems: [],
    resumeCompactionTokens: null,
    keepFullHistory: false,
    onToggleKeepFullHistory: noop,
    environmentUnavailable: null,
    activePendingApproval: null,
    pendingApprovals: [],
    onHeldRequestIdsChange: noop,
    pendingUserInputs: [],
    activePendingProgress: null,
    activePendingResolvedAnswers: null,
    activePendingIsResponding: false,
    activePendingDraftAnswers: {},
    activePendingQuestionIndex: 0,
    respondingRequestIds: [],
    showPlanFollowUpPrompt: false,
    activeProposedPlan: null,
    threadSyncPhase: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    lockedProvider: null,
    providerStatuses: [provider],
    providerCatalogKnown: true,
    pstackSkills: [],
    activeProjectDefaultModelSelection: null,
    activeThreadModelSelection: thread.modelSelection,
    activeProjectId: thread.projectId,
    activeContextWindow: null,
    compactThreadUnavailable: true,
    compactDisabled: true,
    compactDisabledReason: null,
    resolvedTheme: "light",
    settings: DEFAULT_UNIFIED_SETTINGS,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    terminalOpen: false,
    gitCwd: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    threadPullRequests: [],
    onComposerOverlayHeightChange: noop,
    permissionsShownInStrip: false,
    promptRef: { current: "before  after" },
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    composerRef,
    onPageScrollKeyDown: noop,
    onPageScrollKeyUp: noop,
    onPageScrollRelease: noop,
    editingQueuedAttachments: null,
    onRemoveEditingQueuedAttachment: noop,
    onCompactContext: noop,
    onSend: noop,
    onResume: noop,
    onInterrupt: noop,
    onImplementPlanInNewThread: noop,
    onSelectActivePendingUserInputOption: noop,
    onAdvanceActivePendingUserInput: noop,
    onDismissActivePendingUserInput: noop,
    onPreviousActivePendingUserInputQuestion: noop,
    onChangeActivePendingUserInputCustomAnswer: noop,
    onProviderModelSelect: noop,
    onOpenProviderSetup: noop,
    getModelDisabledReason: () => null,
    toggleInteractionMode: noop,
    handleRuntimeModeChange: noop,
    handleInteractionModeChange: noop,
    focusComposer,
    scheduleComposerFocus,
    setThreadError: noop,
    onExpandImage: noop,
    onFileOpen: noop,
  };
  return { props, composerRef };
}

function ComposerWithSelection({ props }: { props: ChatComposerProps }) {
  const selection = useComposerSelection({
    environmentId: props.environmentId,
    composerDraftTarget: props.composerDraftTarget,
    draftThread: null,
    activeThread: props.activeThread,
    activeRuntime: null,
    isLocalDraftThread: false,
    activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
    settings: props.settings,
    providerStatuses: props.providerStatuses,
    lockedProvider: null,
    supportsProviderSwitchingViaHandoff: false,
    multipleModelSelections: null,
    runtimeMode: props.runtimeMode,
    interactionMode: props.interactionMode,
    interactionModeEnabled: true,
    canOverrideServerThreadEnvMode: false,
    setPendingServerThreadEnvModeEntry: () => {},
    setPendingServerThreadStartFromOriginByThreadId: () => {},
    scheduleComposerFocus: props.scheduleComposerFocus,
  });
  return <ChatComposer {...props} onProviderModelSelect={selection.onProviderModelSelectStable} />;
}

it("keeps typing at the removed model mention before the remaining text", async () => {
  const { props, composerRef } = setup();
  await using screen = await render(
    <AppAtomRegistryProvider>
      <ComposerWithSelection props={props} />
    </AppAtomRegistryProvider>,
  );
  const element = screen.container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  const editor = element.editor;
  using _timers = fakeTimers();
  await act(() => composerRef.current?.focusAt(7));
  await userEvent.keyboard("@gpt");
  expect(props.promptRef.current).toBe("before @gpt after");
  await userEvent.keyboard("{Enter}");
  await act(() => vi.advanceTimersByTime(32));
  expect(editor.getText()).toBe("before  after");
  await expect.element(element).toHaveTextContent("before after");
  await userEvent.keyboard("X");
  await expect.element(element).toHaveTextContent("before X after");
});
