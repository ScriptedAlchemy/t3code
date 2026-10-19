import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
// The queries behave like live subscriptions: changing `setup.auth` and calling
// `publish()` re-renders the sections that read them.
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;

function renderSetup(
  options: {
    readOnly?: boolean;
    provider?: ServerProvider;
    enabled?: boolean;
    binaryPath?: string;
  } = {},
) {
  return act(async () =>
    root.render(
      <ProviderSetupSection
        environmentId={environmentId}
        environmentLabel="Remote Google device"
        instanceId={instanceId}
        provider={options.provider ?? provider}
        binaryPath={options.binaryPath}
        enabled={options.enabled ?? true}
        readOnly={options.readOnly ?? false}
        onEnable={vi.fn()}
      />,
    ),
  );
}

function button(label: string) {
  return (
    [...container.querySelectorAll("button")].find(
      (element) => element.textContent === label || element.getAttribute("aria-label") === label,
    ) ?? null
  );
}
async function click(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).not.toBeNull();
  expect(target!.disabled, `${label} disabled`).toBe(false);
  await act(async () => target!.click());
}
function occurrences(text: string) {
  return (container.textContent ?? "").split(text).length - 1;
}
const callbackInput = () =>
  container.querySelector<HTMLInputElement>(`[id="provider-callback-${instanceId}"]`)!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Antigravity setup", () => {
  beforeEach(() => {
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
  });

  it("waits for verified auth after submitting a callback to the selected environment", async () => {
    const callbackUrl = "http://127.0.0.1:5555/?state=test-only&code=test-only";
    await renderSetup();
    await act(async () => userEvent.fill(callbackInput(), callbackUrl));
    await click("Continue");

    expect(setup.completeAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, flowId: "flow-1", callbackUrl },
    });
    expect(occurrences("Signed in.")).toBe(0);
    expect(callbackInput().value).toBe("");

    setup.auth = authState({ phase: "verifying", authorizationUrl: null });
    await publish();
    expect(occurrences("Signed in.")).toBe(0);
    setup.auth = authState({ phase: "succeeded", authorizationUrl: null });
    await renderSetup({
      provider: { ...provider, status: "ready", auth: { status: "authenticated" } },
    });
    expect(occurrences("Signed in.")).toBe(1);
  });

  it("offers sign-in again when credentials expire after a completed auth flow", async () => {
    setup.auth = authState({
      phase: "succeeded",
      authorizationUrl: null,
      message: "Google sign-in complete.",
    });
    await renderSetup({
      provider: { ...provider, status: "ready", auth: { status: "authenticated" } },
    });
    await renderSetup();
    expect(button("Sign in")).not.toBeNull();
    expect(occurrences("Signed in.")).toBe(0);
    expect(occurrences("Google sign-in complete.")).toBe(0);
  });

  it("sends a pasted Claude code to the selected remote environment and clears it", async () => {
    setup.auth = authState({
      interaction: {
        type: "browser",
        id: "code",
        url: "https://claude.com/cai/oauth/authorize?state=fixture",
        requiresConsent: false,
        acceptsCallback: true,
        callbackInputKind: "code",
      },
    });
    await renderSetup();
    expect(container.textContent).toContain("Paste the code from Claude");
    expect(callbackInput().type).toBe("text");
    await act(async () => userEvent.fill(callbackInput(), "fixture-code#state"));
    await click("Continue");

    expect(setup.completeAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, flowId: "flow-1", callbackUrl: "fixture-code#state" },
    });
    expect(callbackInput().value).toBe("");
  });

  it("does not send a callback left over from a replaced sign-in flow", async () => {
    const interaction = {
      type: "browser" as const,
      id: "same-interaction",
      url: "https://example.com/login",
      requiresConsent: false,
      acceptsCallback: true,
    };
    setup.auth = authState({ interaction });
    await renderSetup();
    await act(async () =>
      userEvent.fill(callbackInput(), "http://127.0.0.1:5555/?state=old-flow&code=test-only"),
    );
    setup.auth = authState({ flowId: "flow-2", interaction });
    await publish();
    expect(callbackInput().value).toBe("");
    await act(async () => callbackInput().form!.requestSubmit());

    expect(setup.completeAuth).not.toHaveBeenCalled();
    expect(setup.authState).toHaveBeenLastCalledWith({ environmentId, input: { instanceId } });
  });

  it("coalesces repeated sign-in clicks while start is pending", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    const pending = deferred<{ _tag: "Success"; value: undefined }>();
    setup.startAuth.mockReturnValueOnce(pending.promise);
    await renderSetup();
    const signIn = button("Sign in")!;
    // Both clicks land before React re-renders the button as disabled.
    await act(async () => {
      signIn.click();
      signIn.click();
    });

    expect(setup.startAuth).toHaveBeenCalledTimes(1);
    expect(setup.startAuth).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    await act(async () => pending.resolve({ _tag: "Success", value: undefined }));
  });

  it("shows a repeated runtime status message only once", async () => {
    setup.installation = {
      ...setup.installation!,
      operationId: "install-1",
      phase: "verifying",
      message: "Checking the downloaded runtime.",
    };

    await renderSetup();
    expect(occurrences("Checking the downloaded runtime.")).toBe(1);
  });

  it("removes an owned damaged runtime only after confirmation", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      phase: "failed",
      canRemove: true,
      installedVersion: null,
    };
    await renderSetup();
    await click("Remove downloaded runtime");
    expect(setup.confirm).toHaveBeenCalledOnce();
    expect(setup.removeInstall).not.toHaveBeenCalled();

    setup.confirm.mockResolvedValue(true);
    await click("Remove downloaded runtime");
    expect(setup.removeInstall).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  });

  it.each([true, false])(
    "can sign out a verified account when its instance is enabled=%s",
    async (enabled) => {
      setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
      setup.confirm.mockResolvedValue(true);
      await renderSetup({
        enabled,
        provider: {
          ...provider,
          enabled,
          installed: false,
          status: enabled ? "warning" : "disabled",
          auth: { status: "authenticated" },
        },
      });
      await click("Sign out");
      expect(setup.logoutAuth).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    },
  );

  it.each(["unauthenticated", "unknown"] as const)(
    "does not offer sign-out for an unverified %s account",
    async (status) => {
      setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
      await renderSetup({
        provider: { ...provider, auth: { status, canLogout: true } },
      });
      expect(button("Sign in")).not.toBeNull();
      expect(button("Sign out")).toBeNull();
      expect(button("Change account")).toBeNull();
    },
  );

  it("offers account actions after verified login when discovery cannot identify auth", async () => {
    setup.auth = authState({ phase: "succeeded", flowId: null, authorizationUrl: null });
    await renderSetup({ provider: { ...provider, auth: { status: "unknown" } } });
    expect(button("Change account")).not.toBeNull();
    expect(button("Sign out")).not.toBeNull();
    expect(button("Sign in")).toBeNull();
  });

  it("does not let a shared managed install hide an invalid custom binary path", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      installedVersion: "test-version",
      canRemove: true,
    };
    await renderSetup({
      provider: { ...provider, installed: false },
      binaryPath: "/missing/antigravity",
    });
    expect(button("Sign in")?.disabled).toBe(true);
    expect(setup.startAuth).not.toHaveBeenCalled();
  });

  it.each(["read-only", "older-server"] as const)(
    "does not open private setup subscriptions for a %s view",
    async (mode) => {
      const { setup: _setup, ...olderProvider } = provider;
      await renderSetup(mode === "read-only" ? { readOnly: true } : { provider: olderProvider });
      expect(setup.authState).not.toHaveBeenCalled();
      expect(setup.installState).not.toHaveBeenCalled();
      expect(setup.startAuth).not.toHaveBeenCalled();
    },
  );
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
const renderNativeAuth = (options: Parameters<typeof nativeAuth>[0] = {}) =>
  act(async () => root.render(nativeAuth(options)));
function reserveTab() {
  const tab = { location: { href: "" }, opener: {}, close: vi.fn(), closed: false };
  const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  return { tab, open };
}

describe("Native Codex sign-in browser", () => {
  beforeEach(() => {
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
  });

  it("installs Codex before sign-in and waits for the instance to report it installed", async () => {
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
    await renderNativeAuth({ autoOpenBrowser: false, provider: missing });
    expect(button("Sign in")?.disabled).toBe(true);

    await click("Install Codex CLI");
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
    expect(occurrences("Codex CLI is installed. Checking whether this provider can run it.")).toBe(
      1,
    );
    expect(button("Sign in")?.disabled).toBe(true);
    await renderNativeAuth({ autoOpenBrowser: false, provider: missing });
    expect(setup.refreshProviders).toHaveBeenCalledOnce();

    await renderNativeAuth({ autoOpenBrowser: false, provider: { ...missing, installed: true } });
    expect(button("Sign in")?.disabled).toBe(false);
  });

  it("opens the sign-in page only in the client that started sign-in", async () => {
    const { tab, open } = reserveTab();
    await renderNativeAuth();
    await click("Sign in");
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
    expect(button("Open browser")?.disabled).toBe(false);

    const otherClient = createRoot(document.createElement("div"));
    await act(async () => otherClient.render(nativeAuth({})));
    await act(async () => otherClient.unmount());
    expect(open.mock.calls).toEqual([["", "_blank"]]);
    expect(setup.openExternal).not.toHaveBeenCalled();
  });

  it("opens the desktop browser after the user starts sign-in", async () => {
    vi.stubGlobal("desktopBridge", {});
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await renderNativeAuth();
    await click("Sign in");
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
    await renderNativeAuth();
    expect(setup.openExternal).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it("closes a reserved tab when sign-in fails before a URL arrives", async () => {
    const { tab } = reserveTab();
    await renderNativeAuth();
    await click("Sign in");
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
    expect(button("Retry sign-in")?.disabled).toBe(false);
  });
});

describe("Codex runtime path", () => {
  const binaryPathInput = () =>
    container.querySelector<HTMLInputElement>('[aria-label="Codex binary path"]');

  beforeEach(() => {
    setup.installation = {
      ...codexInstallation,
      phase: "succeeded",
      version: "0.156.1",
      installedVersion: "0.156.1",
      executablePath: "/managed/codex/bin/codex",
      canRemove: true,
    };
  });

  it("shows the executable resolved for the native CLI account", async () => {
    const selectedPath = "/instance-tools/codex/bin/codex";
    await act(async () =>
      root.render(
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
      ),
    );
    expect(binaryPathInput()?.value).toBe(selectedPath);
  });

  it("uses the installation path for managed Codex accounts", async () => {
    await act(async () =>
      root.render(
        <CodexManagedRuntimeFields
          environmentId={environmentId}
          instanceId={nativeInstanceId}
          setupMode="managed"
          provider={codexProvider}
        />,
      ),
    );
    expect(binaryPathInput()?.value).toBe("/managed/codex/bin/codex");
  });
});
