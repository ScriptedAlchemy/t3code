import { cloneElement, isValidElement, type FunctionComponent, type ReactElement } from "react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

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
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useRef: reactHookHarness.useRef,
    useEffect: (effect: () => void | (() => void)) => {
      setup.effects.push(effect);
    },
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  return { ...actual, useAtomValue: () => true };
});

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerAuthState: setup.authState,
    providerInstallState: setup.installState,
    startProviderAuth: setup.startAuth,
    completeProviderAuth: setup.completeAuth,
    respondProviderAuth: setup.respondAuth,
    cancelProviderAuth: setup.cancelAuth,
    logoutProviderAuth: setup.logoutAuth,
    startProviderInstall: Object.assign(setup.startInstall, {
      permissionAtom: () => "can-install",
    }),
    cancelProviderInstall: Object.assign(setup.cancelInstall, {
      permissionAtom: () => "can-install",
    }),
    removeProviderInstallation: Object.assign(setup.removeInstall, {
      permissionAtom: () => "can-install",
    }),
    refreshProviders: setup.refreshProviders,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: string) => ({
    data: atom === "auth" ? setup.auth : setup.installation,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({
    dialogs: { confirm: setup.confirm },
    shell: { openExternal: setup.openExternal },
  }),
}));

import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { CodexManagedRuntimeFields } from "./CodexSetupSection";
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

function renderSetup(
  options: {
    readOnly?: boolean;
    provider?: ServerProvider;
    enabled?: boolean;
    binaryPath?: string;
  } = {},
) {
  hooks.beginRender();
  const view = ProviderSetupSection({
    environmentId,
    environmentLabel: "Remote Google device",
    instanceId,
    provider: options.provider ?? provider,
    binaryPath: options.binaryPath,
    enabled: options.enabled ?? true,
    readOnly: options.readOnly ?? false,
    onEnable: vi.fn(),
  });
  const actions = visitElements(
    view,
    (element) =>
      typeof element.type === "function" &&
      element.props.environmentId === environmentId &&
      element.props.instanceId === instanceId,
  );
  if (!actions) return view;
  const Actions = actions.type as FunctionComponent<Record<string, unknown>>;
  function expand(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(expand);
    if (!isValidElement<Record<string, unknown>>(node)) return node;
    if (node.type === ProviderAuthenticationSection)
      return ProviderAuthenticationSection(
        node.props as Parameters<typeof ProviderAuthenticationSection>[0],
      );
    return cloneElement(
      node,
      Object.fromEntries(Object.entries(node.props).map(([key, value]) => [key, expand(value)])),
    );
  }
  return expand(Actions(actions.props));
}

function button(view: unknown, label: string) {
  return visitElements(
    view,
    (element) =>
      (element.props.children === label || element.props["aria-label"] === label) &&
      typeof element.props.onClick === "function",
  );
}

function countElements(
  node: unknown,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): number {
  if (Array.isArray(node)) {
    return node.reduce((total, child) => total + countElements(child, predicate), 0);
  }
  if (!isValidElement<Record<string, unknown>>(node)) return 0;
  return (
    Number(predicate(node)) +
    Object.values(node.props).reduce<number>(
      (total, value) => total + countElements(value, predicate),
      0,
    )
  );
}

function click(view: unknown, label: string) {
  const target = button(view, label);
  if (!target) throw new Error(`Missing button: ${label}`);
  if (target.props.disabled) throw new Error(`Button is disabled: ${label}`);
  (target.props.onClick as () => void)();
}

function setCallback(view: unknown, value: string) {
  const input = visitElements(
    view,
    (element) => element.props.id === `provider-callback-${instanceId}`,
  );
  if (!input) throw new Error("Missing callback input.");
  (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

function submitCallback(view: unknown) {
  const form = visitElements(view, (element) => element.type === "form");
  if (!form) throw new Error("Missing callback form.");
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({
    preventDefault: vi.fn(),
  });
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Antigravity setup", () => {
  beforeEach(() => {
    hooks.reset();
    setup.effects = [];
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
  });

  it("waits for verified auth after submitting a callback to the selected environment", async () => {
    const callbackUrl = "http://127.0.0.1:5555/?state=test-only&code=test-only";
    setCallback(renderSetup(), callbackUrl);
    submitCallback(renderSetup());
    await flushPromises();

    expect(setup.completeAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, flowId: "flow-1", callbackUrl },
    });
    let view = renderSetup();
    expect(visitElements(view, (element) => element.props.children === "Signed in.")).toBeNull();
    expect(
      visitElements(view, (element) => element.props.id === `provider-callback-${instanceId}`)
        ?.props.value,
    ).toBe("");

    setup.auth = authState({ phase: "verifying", authorizationUrl: null });
    expect(
      visitElements(renderSetup(), (element) => element.props.children === "Signed in."),
    ).toBeNull();
    setup.auth = authState({ phase: "succeeded", authorizationUrl: null });
    view = renderSetup({
      provider: { ...provider, status: "ready", auth: { status: "authenticated" } },
    });
    expect(
      visitElements(view, (element) => element.props.children === "Signed in."),
    ).not.toBeNull();
  });

  it("offers sign-in again when credentials expire after a completed auth flow", () => {
    setup.auth = authState({
      phase: "succeeded",
      authorizationUrl: null,
      message: "Google sign-in complete.",
    });
    renderSetup({
      provider: { ...provider, status: "ready", auth: { status: "authenticated" } },
    });
    const expired = renderSetup();
    expect(button(expired, "Sign in")).not.toBeNull();
    expect(visitElements(expired, (element) => element.props.children === "Signed in.")).toBeNull();
    expect(
      visitElements(expired, (element) => element.props.children === "Google sign-in complete."),
    ).toBeNull();
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
    let tree = renderSetup();
    const field = visitElements(
      tree,
      (element) => element.props.id === `provider-callback-${instanceId}`,
    )!;
    expect(field.props.type).toBe("text");
    setCallback(tree, "fixture-code#state");
    tree = renderSetup();
    submitCallback(tree);
    await flushPromises();
    expect(setup.completeAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, flowId: "flow-1", callbackUrl: "fixture-code#state" },
    });
    expect(
      visitElements(
        renderSetup(),
        (element) => element.props.id === `provider-callback-${instanceId}`,
      )!.props.value,
    ).toBe("");
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
    setCallback(renderSetup(), "http://127.0.0.1:5555/?state=old-flow&code=test-only");
    setup.auth = authState({ flowId: "flow-2", interaction });
    submitCallback(renderSetup());
    await flushPromises();

    expect(setup.completeAuth).not.toHaveBeenCalled();
    expect(setup.authState).toHaveBeenLastCalledWith({ environmentId, input: { instanceId } });
  });

  it("coalesces repeated sign-in clicks while start is pending", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    let completeStart: (value: { _tag: "Success"; value: undefined }) => void = () => {
      throw new Error("Missing start resolver.");
    };
    const pending = new Promise<{ _tag: "Success"; value: undefined }>((resolve) => {
      completeStart = resolve;
    });
    setup.startAuth.mockReturnValueOnce(pending);
    const view = renderSetup();
    click(view, "Sign in");
    click(view, "Sign in");

    expect(setup.startAuth).toHaveBeenCalledTimes(1);
    expect(setup.startAuth).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    completeStart({ _tag: "Success", value: undefined });
    await flushPromises();
  });

  it("shows a repeated runtime status message only once", () => {
    setup.installation = {
      ...setup.installation!,
      operationId: "install-1",
      phase: "verifying",
      message: "Checking the downloaded runtime.",
    };

    const view = renderSetup();
    expect(
      countElements(
        view,
        (element) => element.props.children === "Checking the downloaded runtime.",
      ),
    ).toBe(1);
  });

  it("removes an owned damaged runtime only after confirmation", async () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      phase: "failed",
      canRemove: true,
      installedVersion: null,
    };
    const view = renderSetup();
    click(view, "Remove downloaded runtime");
    await flushPromises();
    expect(setup.removeInstall).not.toHaveBeenCalled();

    setup.confirm.mockResolvedValue(true);
    click(view, "Remove downloaded runtime");
    await flushPromises();
    expect(setup.removeInstall).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  });

  it.each([true, false])(
    "can sign out a verified account when its instance is enabled=%s",
    async (enabled) => {
      setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
      setup.confirm.mockResolvedValue(true);
      const view = renderSetup({
        enabled,
        provider: {
          ...provider,
          enabled,
          installed: false,
          status: enabled ? "warning" : "disabled",
          auth: { status: "authenticated" },
        },
      });
      click(view, "Sign out");
      await flushPromises();
      expect(setup.logoutAuth).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    },
  );

  it.each(["unauthenticated", "unknown"] as const)(
    "does not offer sign-out for an unverified %s account",
    (status) => {
      setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
      const view = renderSetup({
        provider: { ...provider, auth: { status, canLogout: true } },
      });
      expect(button(view, "Sign in")).not.toBeNull();
      expect(button(view, "Sign out")).toBeNull();
      expect(button(view, "Change account")).toBeNull();
    },
  );

  it("offers account actions after verified login when discovery cannot identify auth", () => {
    setup.auth = authState({ phase: "succeeded", flowId: null, authorizationUrl: null });
    const view = renderSetup({ provider: { ...provider, auth: { status: "unknown" } } });
    expect(button(view, "Change account")).not.toBeNull();
    expect(button(view, "Sign out")).not.toBeNull();
    expect(button(view, "Sign in")).toBeNull();
  });

  it("does not let a shared managed install hide an invalid custom binary path", () => {
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      installedVersion: "test-version",
      canRemove: true,
    };
    const view = renderSetup({
      provider: { ...provider, installed: false },
      binaryPath: "/missing/antigravity",
    });
    expect(button(view, "Sign in")?.props.disabled).toBe(true);
    expect(setup.startAuth).not.toHaveBeenCalled();
  });

  it.each(["read-only", "older-server"] as const)(
    "does not open private setup subscriptions for a %s view",
    (mode) => {
      const { setup: _setup, ...olderProvider } = provider;
      renderSetup(mode === "read-only" ? { readOnly: true } : { provider: olderProvider });
      expect(setup.authState).not.toHaveBeenCalled();
      expect(setup.installState).not.toHaveBeenCalled();
      expect(setup.startAuth).not.toHaveBeenCalled();
    },
  );
});

const nativeInstanceId = ProviderInstanceId.make("codex_personal");
function renderNativeAuth(autoOpenBrowser = true, providerOverrides: Partial<ServerProvider> = {}) {
  hooks.beginRender();
  const view = ProviderAuthenticationSection({
    environmentId,
    environmentLabel: "Remote device",
    instanceId: nativeInstanceId,
    provider: {
      ...provider,
      ...providerOverrides,
      instanceId: nativeInstanceId,
      driver: ProviderDriverKind.make("codex"),
    },
    readOnly: false,
    autoOpenBrowser,
  });
  for (const effect of setup.effects.splice(0)) effect();
  return view;
}

describe("Native Codex sign-in browser", () => {
  beforeEach(() => {
    hooks.reset();
    setup.effects = [];
    vi.clearAllMocks();
    setup.auth = authState({
      instanceId: nativeInstanceId,
      phase: "idle",
      flowId: null,
      authorizationUrl: null,
    });
    setup.startAuth.mockResolvedValue({
      _tag: "Success",
      value: { ...setup.auth, phase: "starting", flowId: "native-flow" },
    });
    setup.installation = {
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
    setup.startInstall.mockReset().mockResolvedValue({
      _tag: "Success",
      value: setup.installation,
    });
    setup.cancelInstall
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: setup.installation });
    setup.refreshProviders.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    setup.openExternal.mockResolvedValue(undefined);
  });

  it("installs Codex before sign-in and waits for the instance to report it installed", async () => {
    const missingProvider = {
      installed: false,
      setup: { canAuthenticate: true, canInstall: true },
    } satisfies Partial<ServerProvider>;
    setup.installation = {
      ...setup.installation!,
      phase: "succeeded",
      installedVersion: "0.156.1",
      executablePath: "/host/bin/codex",
      source: "local",
    };
    let view = renderNativeAuth(false, missingProvider);
    expect(button(view, "Sign in")?.props.disabled).toBe(true);
    expect(button(view, "Install Codex CLI")).toBeDefined();

    click(view, "Install Codex CLI");
    await flushPromises();
    expect(setup.startInstall).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: nativeInstanceId },
    });

    setup.installation = {
      ...setup.installation!,
      operationId: "managed-install",
      phase: "succeeded",
      installedVersion: "0.156.1",
      executablePath: "/managed/codex/bin/codex",
      source: "managed",
    };
    view = renderNativeAuth(false, missingProvider);
    expect(setup.refreshProviders).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: nativeInstanceId },
    });
    expect(button(view, "Sign in")?.props.disabled).toBe(true);
    view = renderNativeAuth(false, missingProvider);
    expect(setup.refreshProviders).toHaveBeenCalledTimes(1);

    view = renderNativeAuth(false, { ...missingProvider, installed: true });
    expect(button(view, "Sign in")?.props.disabled).toBe(false);
  });

  it("opens the sign-in page only in the client that started sign-in", async () => {
    const tab = { location: { href: "" }, opener: {}, close: vi.fn(), closed: false };
    const open = vi.fn(() => tab);
    vi.stubGlobal("window", { open });
    try {
      click(renderNativeAuth(), "Sign in");
      expect(open).toHaveBeenCalledWith("", "_blank");
      await flushPromises();
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
      const view = renderNativeAuth();
      expect(tab.location.href).toBe("https://auth.openai.com/device");
      expect(setup.startAuth).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId: nativeInstanceId },
      });
      expect(button(view, "Open browser")?.props.disabled).toBe(false);
      hooks.reset();
      renderNativeAuth();
      expect(open.mock.calls).toEqual([["", "_blank"]]);
      expect(setup.openExternal.mock.calls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens the desktop browser after the user starts sign-in", async () => {
    vi.stubGlobal("window", { desktopBridge: {} });
    try {
      click(renderNativeAuth(), "Sign in");
      await flushPromises();
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
      renderNativeAuth();
      expect(setup.openExternal).toHaveBeenCalledWith("https://auth.openai.com/test");
      renderNativeAuth();
      expect(setup.openExternal.mock.calls).toEqual([["https://auth.openai.com/test"]]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("closes a reserved tab when sign-in fails before a URL arrives", async () => {
    const close = vi.fn();
    const tab = { location: { href: "" }, opener: {}, close, closed: false };
    vi.stubGlobal("window", { open: () => tab });
    try {
      click(renderNativeAuth(), "Sign in");
      await flushPromises();
      setup.auth = authState({
        instanceId: nativeInstanceId,
        phase: "failed",
        flowId: "native-flow",
        authorizationUrl: null,
        message: "Could not start Codex.",
      });
      const view = renderNativeAuth();
      expect(close.mock.calls).toEqual([[]]);
      expect(button(view, "Retry sign-in")?.props.disabled).toBe(false);
      expect(tab.location.href).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Codex runtime path", () => {
  beforeEach(() => {
    hooks.reset();
    setup.installation = {
      driver: ProviderDriverKind.make("codex"),
      operationId: null,
      phase: "succeeded",
      downloadedBytes: 0,
      totalBytes: null,
      version: "0.156.1",
      installedVersion: "0.156.1",
      executablePath: "/managed/codex/bin/codex",
      canRemove: true,
      message: null,
    };
  });

  it("shows the executable resolved for the native CLI account", () => {
    const selectedPath = "/instance-tools/codex/bin/codex";
    hooks.beginRender();
    const view = CodexManagedRuntimeFields({
      environmentId,
      instanceId: nativeInstanceId,
      setupMode: "cli",
      provider: {
        ...provider,
        driver: ProviderDriverKind.make("codex"),
        runtimePaths: {
          homePath: "/home/user/.codex",
          shadowHomePath: "/home/user/.t3/providers/codex/personal/cli",
          binaryPath: selectedPath,
        },
      },
    });

    const binary = visitElements(
      view,
      (element) => element.props["aria-label"] === "Codex binary path",
    );
    expect(binary?.props.value).toBe(selectedPath);
  });

  it("uses the installation path for managed Codex accounts", () => {
    hooks.beginRender();
    const view = CodexManagedRuntimeFields({
      environmentId,
      instanceId: nativeInstanceId,
      setupMode: "managed",
      provider: { ...provider, driver: ProviderDriverKind.make("codex") },
    });

    const binary = visitElements(
      view,
      (element) => element.props["aria-label"] === "Codex binary path",
    );
    expect(binary?.props.value).toBe("/managed/codex/bin/codex");
  });
});
