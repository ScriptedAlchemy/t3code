import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal, type Screen } from "../../../test/render";

const setup = vi.hoisted(() => ({
  auth: null as ProviderAuthState | null,
  installation: null as ProviderInstallState | null,
  authState: vi.fn(() => "auth"),
  installState: vi.fn(() => "installation"),
  startAuth: vi.fn(),
  completeAuth: vi.fn(),
  respondAuth: vi.fn(),
  cancelAuth: vi.fn(),
  logoutAuth: vi.fn(),
  startInstall: vi.fn(),
  cancelInstall: vi.fn(),
  removeInstall: vi.fn(),
  refreshProviders: vi.fn(),
  confirm: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const permitted = (command: object) => Object.assign(command, { permissionAtom: () => allowed });
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providerAuthState: setup.authState as never,
      providerInstallState: setup.installState as never,
      startProviderAuth: setup.startAuth as never,
      completeProviderAuth: setup.completeAuth as never,
      respondProviderAuth: setup.respondAuth as never,
      cancelProviderAuth: setup.cancelAuth as never,
      logoutProviderAuth: setup.logoutAuth as never,
      startProviderInstall: permitted(setup.startInstall) as never,
      cancelProviderInstall: permitted(setup.cancelInstall) as never,
      removeProviderInstallation: permitted(setup.removeInstall) as never,
      refreshProviders: setup.refreshProviders as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
const queryListeners = vi.hoisted(() => new Set<() => void>());
vi.mock(import("../../state/query"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    queryListeners.add(listener);
    return () => queryListeners.delete(listener);
  };
  return {
    ...(await original()),
    useEnvironmentQuery: ((atom: string) => ({
      data: useSyncExternalStore(subscribe, () =>
        atom === "auth" ? setup.auth : setup.installation,
      ),
      error: null,
      isPending: false,
      refresh: vi.fn(),
    })) as never,
  };
});
const publish = () =>
  act(async () => {
    for (const listener of queryListeners) listener();
  });
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: () =>
    ({
      dialogs: { confirm: setup.confirm },
      shell: { openExternal: setup.openExternal },
    }) as never,
}));

import { CodexManagedRuntimeFields } from "./CodexSetupSection";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { ProviderSetupSection } from "./ProviderSetupSection";

const environmentId = EnvironmentId.make("remote-google");
const instanceId = ProviderInstanceId.make("antigravity_work");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("antigravity"),
  installed: true,
  enabled: true,
  version: "test-version",
  status: "error",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-09-02T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
  setup: { canAuthenticate: true, canInstall: true },
};

function authState(patch: Partial<ProviderAuthState> = {}): ProviderAuthState {
  return {
    instanceId,
    phase: "waiting",
    flowId: "flow-1",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test-only",
    expiresAt: "2026-09-02T00:05:00.000Z",
    message: null,
    ...patch,
  };
}

interface SectionOptions {
  readOnly?: boolean;
  provider?: ServerProvider;
  enabled?: boolean;
  binaryPath?: string;
}

function section(options: SectionOptions = {}) {
  return (
    <ProviderSetupSection
      environmentId={environmentId}
      environmentLabel="Remote Google device"
      instanceId={instanceId}
      provider={options.provider ?? provider}
      binaryPath={options.binaryPath}
      enabled={options.enabled ?? true}
      readOnly={options.readOnly ?? false}
      onEnable={vi.fn()}
    />
  );
}

function withQueries(screen: Screen) {
  const { container } = screen;
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (element) => element.textContent === label || element.getAttribute("aria-label") === label,
    ) ?? null;
  return Object.assign(screen, {
    button,
    async click(label: string) {
      const target = button(label);
      expect(target, `button ${label}`).not.toBeNull();
      expect(target!.disabled, `${label} disabled`).toBe(false);
      await act(async () => target!.click());
    },
    occurrences: (text: string) => (container.textContent ?? "").split(text).length - 1,
    callbackInput: () =>
      container.querySelector<HTMLInputElement>(`[id="provider-callback-${instanceId}"]`)!,
  });
}

async function renderSetup(options: SectionOptions = {}) {
  return withQueries(await render(section(options)));
}

function resetSetup() {
  vi.clearAllMocks();
  setup.auth = authState();
  setup.installation = {
    driver: ProviderDriverKind.make("antigravity"),
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: null,
    version: null,
    installedVersion: null,
    canRemove: false,
    message: null,
  };
  for (const command of [
    setup.startAuth,
    setup.completeAuth,
    setup.cancelAuth,
    setup.logoutAuth,
    setup.startInstall,
    setup.cancelInstall,
    setup.removeInstall,
  ]) {
    command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  }
  setup.confirm.mockReset().mockResolvedValue(false);
}

describe("Antigravity setup", () => {
  it("waits for verified auth after submitting a callback to the selected environment", async () => {
    resetSetup();
    const callbackUrl = "http://127.0.0.1:5555/?state=test-only&code=test-only";
    await using screen = await renderSetup();
    await userEvent.fill(screen.callbackInput(), callbackUrl);
    await screen.click("Continue");

    expect(setup.completeAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, flowId: "flow-1", callbackUrl },
    });
    expect(screen.occurrences("Signed in.")).toBe(0);
    expect(screen.callbackInput().value).toBe("");

    setup.auth = authState({ phase: "verifying", authorizationUrl: null });
    await publish();
    expect(screen.occurrences("Signed in.")).toBe(0);
    setup.auth = authState({ phase: "succeeded", authorizationUrl: null });
    await screen.rerender(
      section({
        provider: { ...provider, status: "ready", auth: { status: "authenticated" } },
      }),
    );
    expect(screen.occurrences("Signed in.")).toBe(1);
  });

  it("does not send a callback left over from a replaced sign-in flow", async () => {
    resetSetup();
    const interaction = {
      type: "browser" as const,
      id: "same-interaction",
      url: "https://example.com/login",
      requiresConsent: false,
      acceptsCallback: true,
    };
    setup.auth = authState({ interaction });
    await using screen = await renderSetup();
    await userEvent.fill(
      screen.callbackInput(),
      "http://127.0.0.1:5555/?state=old-flow&code=test-only",
    );
    setup.auth = authState({ flowId: "flow-2", interaction });
    await publish();
    expect(screen.callbackInput().value).toBe("");
    await act(async () => screen.callbackInput().form!.requestSubmit());

    expect(setup.completeAuth).not.toHaveBeenCalled();
    expect(setup.authState).toHaveBeenLastCalledWith({ environmentId, input: { instanceId } });
  });

  it("does not let a shared managed install hide an invalid custom binary path", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      installedVersion: "test-version",
      canRemove: true,
    };
    await using screen = await renderSetup({
      provider: { ...provider, installed: false },
      binaryPath: "/missing/antigravity",
    });
    expect(screen.button("Sign in")?.disabled).toBe(true);
    expect(setup.startAuth).not.toHaveBeenCalled();
  });
});

const nativeInstanceId = ProviderInstanceId.make("codex_personal");
const codexProvider: ServerProvider = {
  ...provider,
  instanceId: nativeInstanceId,
  driver: ProviderDriverKind.make("codex"),
};
const codexInstallation: ProviderInstallState = {
  driver: ProviderDriverKind.make("codex"),
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: null,
  installedVersion: null,
  canRemove: false,
  message: null,
};

function nativeAuth(options: { autoOpenBrowser?: boolean; provider?: Partial<ServerProvider> }) {
  return (
    <ProviderAuthenticationSection
      environmentId={environmentId}
      environmentLabel="Remote device"
      instanceId={nativeInstanceId}
      provider={{ ...codexProvider, ...options.provider }}
      readOnly={false}
      autoOpenBrowser={options.autoOpenBrowser ?? true}
    />
  );
}
async function renderNativeAuth(options: Parameters<typeof nativeAuth>[0] = {}) {
  const screen = withQueries(await render(nativeAuth(options)));
  return Object.assign(screen, {
    rerenderNativeAuth: (next: Parameters<typeof nativeAuth>[0] = {}) =>
      screen.rerender(nativeAuth(next)),
  });
}
function spyWindowOpen(value: Window | null) {
  const open = vi.spyOn(window, "open").mockReturnValue(value);
  return Object.assign(open, { [Symbol.dispose]: () => open.mockRestore() });
}
function reserveTab() {
  const tab = { location: { href: "" }, opener: {}, close: vi.fn(), closed: false };
  const open = spyWindowOpen(tab as unknown as Window);
  return { tab, open, [Symbol.dispose]: () => open[Symbol.dispose]() };
}

describe("Native Codex sign-in browser", () => {
  function prepareNativeSignIn() {
    resetSetup();
    setup.auth = authState({
      instanceId: nativeInstanceId,
      phase: "idle",
      flowId: null,
      authorizationUrl: null,
    });
    setup.startAuth.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { ...setup.auth, phase: "starting", flowId: "native-flow" },
    });
    setup.installation = codexInstallation;
    for (const command of [setup.startInstall, setup.cancelInstall]) {
      command.mockReset().mockResolvedValue({ _tag: "Success", value: codexInstallation });
    }
    setup.refreshProviders.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    setup.openExternal.mockReset().mockResolvedValue(undefined);
  }

  it("installs Codex before sign-in and waits for the instance to report it installed", async () => {
    prepareNativeSignIn();
    const missing = {
      installed: false,
      setup: { canAuthenticate: true, canInstall: true },
    } satisfies Partial<ServerProvider>;
    setup.installation = {
      ...codexInstallation,
      phase: "succeeded",
      installedVersion: "0.156.1",
      executablePath: "/host/bin/codex",
      source: "local",
    };
    await using screen = await renderNativeAuth({ autoOpenBrowser: false, provider: missing });
    expect(screen.button("Sign in")?.disabled).toBe(true);

    await screen.click("Install Codex CLI");
    expect(setup.startInstall).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: nativeInstanceId },
    });

    setup.installation = {
      ...setup.installation,
      operationId: "managed-install",
      executablePath: "/managed/codex/bin/codex",
      source: "managed",
    };
    await publish();
    expect(setup.refreshProviders).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: nativeInstanceId },
    });
    expect(
      screen.occurrences("Codex CLI is installed. Checking whether this provider can run it."),
    ).toBe(1);
    expect(screen.button("Sign in")?.disabled).toBe(true);
    await screen.rerenderNativeAuth({ autoOpenBrowser: false, provider: missing });
    expect(setup.refreshProviders).toHaveBeenCalledOnce();

    await screen.rerenderNativeAuth({
      autoOpenBrowser: false,
      provider: { ...missing, installed: true },
    });
    expect(screen.button("Sign in")?.disabled).toBe(false);
  });

  it("updates an authenticated CLI account and refreshes its models after installation", async () => {
    prepareNativeSignIn();
    setup.installation = {
      ...codexInstallation,
      version: "0.163.0",
      installedVersion: "0.156.1",
      source: "managed",
    };
    const account = {
      installed: true,
      version: "0.156.1",
      auth: { status: "authenticated" as const },
    };
    await using screen = await renderNativeAuth({ autoOpenBrowser: false, provider: account });
    await expect.element(screen.getByRole("button", { name: "Update Codex CLI" })).toBeVisible();
    await screen.click("Update Codex CLI");
    expect(setup.startInstall).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: nativeInstanceId },
    });
    setup.installation = { ...setup.installation, phase: "downloading", operationId: "update" };
    await publish();
    await expect.element(screen.getByRole("button", { name: "Cancel installation" })).toBeVisible();
    setup.installation = { ...setup.installation, phase: "succeeded", installedVersion: "0.163.0" };
    await publish();
    await vi.waitFor(() =>
      expect(setup.refreshProviders).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId: nativeInstanceId },
      }),
    );
    await screen.rerenderNativeAuth({
      autoOpenBrowser: false,
      provider: { ...account, version: "0.163.0" },
    });
    await expect
      .element(screen.getByRole("button", { name: "Update Codex CLI" }))
      .not.toBeInTheDocument();
  });

  it("opens the sign-in page only in the client that started sign-in", async () => {
    prepareNativeSignIn();
    using reserved = reserveTab();
    const { tab, open } = reserved;
    await using screen = await renderNativeAuth();
    await screen.click("Sign in");
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(setup.startAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: nativeInstanceId },
    });

    setup.auth = authState({
      instanceId: nativeInstanceId,
      phase: "waiting",
      flowId: "native-flow",
      interaction: {
        type: "deviceCode",
        id: "native-flow",
        url: "https://auth.openai.com/device",
        userCode: "TEST-CODE",
      },
    });
    await publish();
    expect(tab.location.href).toBe("https://auth.openai.com/device");
    expect(screen.button("Open browser")?.disabled).toBe(false);

    await using otherClient = await render(nativeAuth({}));
    await otherClient.unmount();
    expect(open.mock.calls).toEqual([["", "_blank"]]);
    expect(setup.openExternal).not.toHaveBeenCalled();
  });

  it("opens the desktop browser after the user starts sign-in", async () => {
    prepareNativeSignIn();
    using _desktop = stubGlobal("desktopBridge", {});
    using open = spyWindowOpen(null);
    await using screen = await renderNativeAuth();
    await screen.click("Sign in");
    setup.auth = authState({
      instanceId: nativeInstanceId,
      phase: "waiting",
      flowId: "native-flow",
      interaction: {
        type: "browser",
        id: "native-flow",
        url: "https://auth.openai.com/test",
        requiresConsent: false,
      },
    });
    await publish();
    expect(setup.openExternal).toHaveBeenCalledWith("https://auth.openai.com/test");
    await screen.rerenderNativeAuth();
    expect(setup.openExternal).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it("closes a reserved tab when sign-in fails before a URL arrives", async () => {
    prepareNativeSignIn();
    using reserved = reserveTab();
    const { tab } = reserved;
    await using screen = await renderNativeAuth();
    await screen.click("Sign in");
    setup.auth = authState({
      instanceId: nativeInstanceId,
      phase: "failed",
      flowId: "native-flow",
      authorizationUrl: null,
      message: "Could not start Codex.",
    });
    await publish();
    expect(tab.close).toHaveBeenCalledOnce();
    expect(tab.location.href).toBe("");
    expect(screen.button("Retry sign-in")?.disabled).toBe(false);
  });
});

describe("Codex runtime path", () => {
  const binaryPathInput = (screen: Screen) =>
    screen.container.querySelector<HTMLInputElement>('[aria-label="Codex binary path"]');

  function prepareRuntimePath() {
    resetSetup();
    setup.installation = {
      ...codexInstallation,
      phase: "succeeded",
      version: "0.156.1",
      installedVersion: "0.156.1",
      executablePath: "/managed/codex/bin/codex",
      canRemove: true,
    };
  }

  it("shows the executable resolved for the native CLI account", async () => {
    prepareRuntimePath();
    const selectedPath = "/instance-tools/codex/bin/codex";
    await using screen = await render(
      <CodexManagedRuntimeFields
        environmentId={environmentId}
        instanceId={nativeInstanceId}
        setupMode="cli"
        provider={{
          ...codexProvider,
          runtimePaths: {
            homePath: "/home/user/.codex",
            shadowHomePath: "/home/user/.t3/providers/codex/personal/cli",
            binaryPath: selectedPath,
          },
        }}
      />,
    );
    expect(binaryPathInput(screen)?.value).toBe(selectedPath);
  });

  it("uses the installation path for managed Codex accounts", async () => {
    prepareRuntimePath();
    await using screen = await render(
      <CodexManagedRuntimeFields
        environmentId={environmentId}
        instanceId={nativeInstanceId}
        setupMode="managed"
        provider={codexProvider}
      />,
    );
    expect(binaryPathInput(screen)?.value).toBe("/managed/codex/bin/codex");
  });
});
