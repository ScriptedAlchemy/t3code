import { EnvironmentId, ProviderDriverKind, type AcpRegistrySearchAgent } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const actions = vi.hoisted(() => ({
  update: vi.fn(),
  toast: vi.fn(),
  onOpenChange: vi.fn(),
  canManageProviders: true,
}));

const settingsHooks = vi.hoisted(() => ({
  read: vi.fn(() => ({ providerInstances: {} })),
  mutate: vi.fn(),
  useMutation: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  squashAtomCommandFailure: () => new Error("The settings update failed."),
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: settingsHooks.read,
  usePersistEnvironmentProviderInstanceMutation: settingsHooks.useMutation,
}));

vi.mock("../../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/session")>();
  const hasScope = (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" && scope === "providers:manage" && actions.canManageProviders;
  return { ...actual, useEnvironmentScope: hasScope, readEnvironmentScope: hasScope };
});

vi.mock("../ui/toast", () => ({ toastManager: { add: actions.toast } }));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  type SettingsFormDefinition,
} from "./ProviderSettingsForm";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const remoteEnvironmentId = EnvironmentId.make("remote-device");
const preparedAgent: AcpRegistrySearchAgent = {
  id: "kilo",
  name: "Kilo Code",
  version: "4.2.0",
  description: "Kilo ACP agent",
  authors: ["Kilo"],
  license: "Apache-2.0",
  website: null,
  repository: null,
  icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg",
  distribution: "binary",
  integrity: "sha256",
};

function render(onOpenChange = vi.fn()) {
  hooks.beginRender();
  return AddProviderInstanceDialog({
    open: true,
    environmentId: remoteEnvironmentId,
    environmentLabel: "Remote device",
    onOpenChange,
  });
}

function findByChildren(tree: ReturnType<typeof render>, children: string) {
  const result = visitElements(tree, (element) => element.props.children === children);
  expect(result).not.toBeNull();
  return result!;
}

function selectTraex(tree: ReturnType<typeof render>) {
  const group = visitElements(
    tree,
    (element) => element.props["aria-labelledby"] === "add-instance-driver-label",
  );
  expect(group).not.toBeNull();
  const option = visitElements(group, (element) => element.props.value === "traexBridge");
  expect(option).not.toBeNull();
  (group!.props.onValueChange as (value: string) => void)(option!.props.value as string);
  (findByChildren(render(), "Next").props.onClick as () => void)();
}

async function selectPreparedAcp() {
  const searchStep = render();
  const search = visitElements(
    searchStep,
    (element) =>
      typeof element.type === "function" && element.type.name === "AcpRegistrySearchStep",
  );
  expect(search).not.toBeNull();
  (search?.props.onPrepared as ((agent: AcpRegistrySearchAgent) => void) | undefined)?.(
    preparedAgent,
  );
}

function renderDialog() {
  hooks.beginRender();
  return AddProviderInstanceDialog({
    open: true,
    environmentId: remoteEnvironmentId,
    environmentLabel: "Remote device",
    onOpenChange: actions.onOpenChange,
  });
}

function button(dialog: unknown, label: string) {
  const element = visitElements(
    dialog,
    (entry) => entry.props.children === label && typeof entry.props.onClick === "function",
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

function prepareInstance() {
  let dialog = renderDialog();
  (button(dialog, "Use existing Codex CLI").props.onClick as () => void)();
  dialog = renderDialog();
  const label = visitElements(dialog, (entry) => entry.props.placeholder === "e.g. Work");
  if (!label) throw new Error("Missing instance label input.");
  (label.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "Work" },
  });
  dialog = renderDialog();
  (button(dialog, "Next").props.onClick as () => void)();
  return renderDialog();
}

describe("AddProviderInstanceDialog environment routing", () => {
  beforeEach(() => {
    hooks.reset();
    actions.canManageProviders = true;
    actions.toast.mockReset();
    actions.onOpenChange.mockReset();
    settingsHooks.read.mockReset().mockReturnValue({ providerInstances: {} });
    settingsHooks.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
    settingsHooks.useMutation.mockReset().mockReturnValue(settingsHooks.mutate);
  });

  it("creates a provider with its default identity without typing", async () => {
    let tree = render();
    const group = visitElements(
      tree,
      (element) => element.props["aria-labelledby"] === "add-instance-driver-label",
    );
    (group!.props.onValueChange as (value: string) => void)("grok");
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Add instance").props.onClick as () => void)();
    await Promise.resolve();
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "grok",
      instance: { driver: "grok", enabled: true, displayName: "Grok" },
    });
  });

  it("chooses an unused identity for another account without replacing configured instances", async () => {
    settingsHooks.read.mockReturnValue({
      providerInstances: {
        codex_2: { driver: "codex", enabled: false },
      },
    });
    let tree = render();
    (findByChildren(tree, "Use existing Codex CLI").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Add instance").props.onClick as () => void)();
    await Promise.resolve();
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_3",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Codex",
        config: { setupMode: "existing" },
      },
    });
  });

  it("reads and writes settings through the supplied environment", () => {
    render();

    expect(settingsHooks.read).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
  });

  it("creates a native Codex account without runtime overrides and continues to sign-in", async () => {
    (button(renderDialog(), "Sign in with Codex CLI").props.onClick as () => void)();
    let tree = renderDialog();
    const label = visitElements(tree, (entry) => entry.props.placeholder === "e.g. Work")!;
    (label.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "Personal" },
    });
    tree = renderDialog();
    (button(tree, "Continue to sign-in").props.onClick as () => void)();
    await Promise.resolve();
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_personal",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Personal",
        config: { setupMode: "cli" },
      },
    });
    const authentication = visitElements(
      renderDialog(),
      (entry) =>
        typeof entry.type === "function" && entry.type.name === "ProviderWizardAuthenticationStep",
    );
    expect(authentication?.props).toMatchObject({
      environmentId: remoteEnvironmentId,
      instanceId: "codex_personal",
      autoOpenBrowser: true,
    });
    expect(actions.onOpenChange).not.toHaveBeenCalled();
  });

  it("preserves the existing CLI configuration after leaving the native account path", async () => {
    (button(renderDialog(), "Sign in with Codex CLI").props.onClick as () => void)();
    (button(renderDialog(), "Back").props.onClick as () => void)();
    (button(renderDialog(), "Use existing Codex CLI").props.onClick as () => void)();
    (button(renderDialog(), "Next").props.onClick as () => void)();
    (button(renderDialog(), "Add instance").props.onClick as () => void)();
    await Promise.resolve();
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_2",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Codex",
        config: { setupMode: "existing" },
      },
    });
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("persists a Traex preset as an isolated Codex instance in the selected environment", async () => {
    settingsHooks.read.mockReturnValue({
      providerInstances: { codex_traex: { driver: "codex", enabled: true } },
    });
    let tree = render();
    selectTraex(tree);
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Add instance").props.onClick as () => void)();
    await Promise.resolve();

    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_traex_2",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Traex",
        config: {
          setupMode: "existing",
          homePath: "~/.codex-t3/traex/codex_traex_2",
          launchArgs: expect.any(String),
        },
      },
    });
    const launchArgs: unknown = settingsHooks.mutate.mock.calls[0]?.[0]?.instance.config.launchArgs;
    if (typeof launchArgs !== "string") throw new Error("Missing persisted launch arguments.");
    const args = tokenizeCliArgs(launchArgs);
    expect(args).toContain('model_provider="traex"');
    expect(args).toContainEqual(expect.stringContaining('base_url="http://127.0.0.1:8317/v1"'));
    expect(args).toContainEqual(expect.stringContaining("cat ~/.traex-bridge/api-key"));
    expect(args.join(" ")).not.toContain("model_catalog_url");
    expect(args.join(" ")).not.toContain("features.api_key_model_discovery");
  });

  it.each([
    { name: "default home", editConfig: false, homePath: undefined },
    { name: "another config field", editConfig: true, homePath: undefined },
    { name: "custom home", editConfig: true, homePath: "~/.traex-personal" },
  ])("preserves isolation after changing the Traex ID with $name", async (fixture) => {
    let tree = render();
    selectTraex(tree);
    tree = render();
    if (fixture.editConfig) {
      (findByChildren(tree, "Next").props.onClick as () => void)();
      tree = render();
      const configuration = visitElements(
        tree,
        (element) => element.props.idPrefix === "add-provider-codex",
      );
      (configuration!.props.onChange as (value: Record<string, unknown>) => void)({
        ...(configuration!.props.value as Record<string, unknown>),
        binaryPath: "/opt/codex",
        ...(fixture.homePath === undefined ? {} : { homePath: fixture.homePath }),
      });
      (findByChildren(tree, "Back").props.onClick as () => void)();
      tree = render();
    }
    const instanceId = visitElements(
      tree,
      (element) => element.props.id === "add-provider-instance-id",
    );
    (instanceId!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "traex_custom" },
    });
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Add instance").props.onClick as () => void)();
    await Promise.resolve();

    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "traex_custom",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Traex",
        config: {
          setupMode: "existing",
          homePath: fixture.homePath ?? "~/.codex-t3/traex/traex_custom",
          launchArgs: expect.any(String),
          ...(fixture.editConfig ? { binaryPath: "/opt/codex" } : {}),
        },
      },
    });
  });

  it("derives the Traex home from the final ID after clearing a custom home", async () => {
    let tree = render();
    selectTraex(tree);
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    let configuration = visitElements(
      tree,
      (element) => element.props.idPrefix === "add-provider-codex",
    );
    const homeField = deriveProviderSettingsFields(
      configuration!.props.definition as SettingsFormDefinition,
    ).find((field) => field.key === "homePath");
    if (!homeField) throw new Error("Missing home path field.");
    (configuration!.props.onChange as (value: Record<string, unknown> | undefined) => void)(
      nextProviderConfigWithFieldValue(configuration!.props.value, homeField, "~/.traex-personal"),
    );
    tree = render();
    configuration = visitElements(
      tree,
      (element) => element.props.idPrefix === "add-provider-codex",
    );
    (configuration!.props.onChange as (value: Record<string, unknown> | undefined) => void)(
      nextProviderConfigWithFieldValue(configuration!.props.value, homeField, ""),
    );
    tree = render();
    (findByChildren(tree, "Back").props.onClick as () => void)();
    tree = render();
    const instanceId = visitElements(
      tree,
      (element) => element.props.id === "add-provider-instance-id",
    );
    (instanceId!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "traex_final" },
    });
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Add instance").props.onClick as () => void)();
    await Promise.resolve();

    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "traex_final",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Traex",
        config: {
          setupMode: "existing",
          homePath: "~/.codex-t3/traex/traex_final",
          launchArgs: expect.any(String),
        },
      },
    });
  });

  it("preserves the edited Traex draft after returning to provider selection", async () => {
    let tree = render();
    selectTraex(tree);
    tree = render();
    const label = visitElements(tree, (element) => element.props.id === "add-provider-label");
    (label!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "Personal Traex" },
    });
    tree = render();
    const instanceId = visitElements(
      tree,
      (element) => element.props.id === "add-provider-instance-id",
    );
    (instanceId!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "traex_personal" },
    });
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    const configuration = visitElements(
      tree,
      (element) => element.props.idPrefix === "add-provider-codex",
    );
    (configuration!.props.onChange as (value: Record<string, unknown>) => void)({
      ...(configuration!.props.value as Record<string, unknown>),
      binaryPath: "/opt/codex-personal",
      homePath: "~/.traex-personal",
      launchArgs: "--profile personal",
    });
    tree = render();
    (findByChildren(tree, "Back").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Back").props.onClick as () => void)();
    tree = render();
    selectTraex(tree);
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Add instance").props.onClick as () => void)();
    await Promise.resolve();

    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "traex_personal",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Personal Traex",
        config: {
          setupMode: "existing",
          binaryPath: "/opt/codex-personal",
          homePath: "~/.traex-personal",
          launchArgs: "--profile personal",
        },
      },
    });
  });

  it("restores the manual Codex draft after choosing Traex and switching back", async () => {
    let tree = render();
    (findByChildren(tree, "Use existing Codex CLI").props.onClick as () => void)();
    tree = render();
    const label = visitElements(tree, (element) => element.props.id === "add-provider-label");
    (label!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "Work" },
    });
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    const configuration = visitElements(
      tree,
      (element) => element.props.idPrefix === "add-provider-codex",
    );
    (configuration!.props.onChange as (value: Record<string, unknown>) => void)({
      binaryPath: "/opt/codex",
      homePath: "~/.codex-work",
    });
    (findByChildren(tree, "Back").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Back").props.onClick as () => void)();
    tree = render();
    selectTraex(tree);
    tree = render();
    (findByChildren(tree, "Back").props.onClick as () => void)();
    tree = render();
    const group = visitElements(
      tree,
      (element) => element.props["aria-labelledby"] === "add-instance-driver-label",
    );
    (group!.props.onValueChange as (value: string) => void)("codex");
    tree = render();
    (findByChildren(tree, "Use existing Codex CLI").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Add instance").props.onClick as () => void)();
    await Promise.resolve();

    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_work",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Work",
        config: {
          setupMode: "existing",
          binaryPath: "/opt/codex",
          homePath: "~/.codex-work",
        },
      },
    });
  });

  it("awaits an atomic create before closing and retains prepared ACP metadata", async () => {
    const onOpenChange = vi.fn();
    let resolveMutation!: (value: { readonly _tag: "Success"; readonly value: unknown }) => void;
    settingsHooks.mutate.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    await selectPreparedAcp();

    const identityStep = render(onOpenChange);
    expect(
      visitElements(identityStep, (element) => {
        const content = JSON.stringify(element.props.children);
        return content?.includes("4.2.0") === true && content.includes("binary");
      }),
    ).not.toBeNull();
    (
      findByChildren(identityStep, "Continue to sign-in").props.onClick as (() => void) | undefined
    )?.();
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_kilo_code",
      instance: {
        driver: ProviderDriverKind.make("acpRegistry"),
        enabled: true,
        displayName: "Kilo Code",
        config: {
          agentId: "kilo",
          distribution: "auto",
          registryIconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg",
        },
      },
    });
    expect(onOpenChange).not.toHaveBeenCalled();

    resolveMutation({ _tag: "Success", value: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(onOpenChange).not.toHaveBeenCalled();
    const signInStep = render(onOpenChange);
    const authentication = visitElements(
      signInStep,
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "ProviderWizardAuthenticationStep",
    );
    expect(authentication?.props.instanceId).toBe("acpRegistry_kilo_code");
    expect(authentication?.props.environmentId).toBe(remoteEnvironmentId);
    expect(settingsHooks.mutate).toHaveBeenCalledTimes(1);
    (authentication!.props.onFinish as () => void)();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("configures a manually entered registry agent from the first provider screen", async () => {
    let tree = render();
    const search = visitElements(
      tree,
      (element) =>
        typeof element.type === "function" && element.type.name === "AcpRegistrySearchStep",
    );
    (search!.props.onManualConfiguration as () => void)();
    tree = render();
    const configuration = visitElements(
      tree,
      (element) => element.props.idPrefix === "add-provider-acpRegistry-manual",
    );
    (configuration!.props.onChange as (value: Record<string, unknown>) => void)({
      agentId: "devin",
    });
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Continue to sign-in").props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_custom",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        config: { agentId: "devin" },
      },
    });
    tree = render();
    expect(
      visitElements(
        tree,
        (element) =>
          typeof element.type === "function" &&
          element.type.name === "ProviderWizardAuthenticationStep",
      ),
    ).not.toBeNull();
  });

  it("creates a local command in the selected environment without a sign-in step", async () => {
    const onOpenChange = vi.fn();
    let tree = render(onOpenChange);
    const search = visitElements(
      tree,
      (element) =>
        typeof element.type === "function" && element.type.name === "AcpRegistrySearchStep",
    );
    (search!.props.onLocalConfiguration as () => void)();
    tree = render(onOpenChange);
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render(onOpenChange);
    expect(findByChildren(tree, "Executable is required.")).not.toBeNull();
    expect(settingsHooks.mutate).not.toHaveBeenCalled();

    const configuration = visitElements(
      tree,
      (element) => element.props.idPrefix === "add-provider-acpRegistry-manual",
    );
    const commandArgs = ["--profile", "acp", " literal $(value) ; ", ""];
    (configuration!.props.onChange as (value: Record<string, unknown>) => void)({
      source: "local",
      commandPath: "dsh",
      commandArgs,
    });
    const environmentEditor = visitElements(
      tree,
      (element) =>
        typeof element.type === "function" && element.type.name === "ProviderEnvironmentSection",
    );
    const environment = [{ name: "DSH_PROFILE", value: "work", sensitive: false }];
    (environmentEditor!.props.onChange as (value: typeof environment) => void)(environment);
    tree = render(onOpenChange);
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render(onOpenChange);
    const label = visitElements(tree, (element) => element.props.id === "add-provider-label");
    (label!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "Deepseek Harness" },
    });
    tree = render(onOpenChange);
    (findByChildren(tree, "Add instance").props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();

    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_deepseek_harness",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "Deepseek Harness",
        config: { source: "local", commandPath: "dsh", commandArgs },
        environment,
      },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    tree = render(onOpenChange);
    expect(
      visitElements(
        tree,
        (element) =>
          typeof element.type === "function" &&
          element.type.name === "ProviderWizardAuthenticationStep",
      ),
    ).toBeNull();
  });

  it("keeps the dialog open when the atomic upsert fails", async () => {
    settingsHooks.mutate.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Conflict") });
    const onOpenChange = vi.fn();
    await selectPreparedAcp();

    const identityStep = render(onOpenChange);
    (
      findByChildren(identityStep, "Continue to sign-in").props.onClick as (() => void) | undefined
    )?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("adds an instance with the selected environment's provider grant alone", async () => {
    const dialog = prepareInstance();
    (button(dialog, "Add instance").props.onClick as () => void)();

    await Promise.resolve();
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_work",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Work",
        config: { setupMode: "existing" },
      },
    });
    expect(actions.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Provider instance added" }),
    );
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("rejects a queued save after the provider grant is revoked", () => {
    const dialog = prepareInstance();
    const save = button(dialog, "Add instance").props.onClick as () => void;
    actions.canManageProviders = false;
    save();

    expect(settingsHooks.mutate).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(button(renderDialog(), "Add instance").props.disabled).toBe(true);
  });

  it("keeps a denied draft available when the provider grant arrives", async () => {
    actions.canManageProviders = false;
    let dialog = prepareInstance();
    (button(dialog, "Add instance").props.onClick as () => void)();
    expect(settingsHooks.mutate).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();

    actions.canManageProviders = true;
    dialog = renderDialog();
    expect(button(dialog, "Add instance").props.disabled).toBe(false);
    (button(dialog, "Add instance").props.onClick as () => void)();
    await Promise.resolve();
    expect(settingsHooks.mutate).toHaveBeenCalledOnce();
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });
});
