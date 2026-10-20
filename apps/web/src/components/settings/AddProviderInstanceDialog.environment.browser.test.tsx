import { EnvironmentId, ProviderDriverKind, type AcpRegistrySearchAgent } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const actions = vi.hoisted(() => ({
  toast: vi.fn(),
  onOpenChange: vi.fn(),
  canManageProviders: true,
}));
const settingsHooks = vi.hoisted(() => ({
  read: vi.fn(() => ({ providerInstances: {} })),
  mutate: vi.fn(),
  useMutation: vi.fn(),
}));
const preparedAgent = vi.hoisted((): AcpRegistrySearchAgent => ({
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
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  squashAtomCommandFailure: () => new Error("The settings update failed."),
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: settingsHooks.read as never,
  usePersistEnvironmentProviderInstanceMutation: settingsHooks.useMutation as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const hasScope = (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" && scope === "providers:manage" && actions.canManageProviders;
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: actions.toast } };
});
// The registry search, ChatGPT sharing, and the sign-in step talk to the environment
// over RPC; these stand-ins expose the choices a user makes there.
vi.mock(import("./AcpRegistrySearchStep"), async (original) => ({
  ...(await original()),
  AcpRegistrySearchStep: ((props: {
    onPrepared: (agent: AcpRegistrySearchAgent) => void;
    onManualConfiguration: () => void;
    onLocalConfiguration: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => props.onPrepared(preparedAgent)}>
        Use Kilo Code
      </button>
      <button type="button" onClick={props.onManualConfiguration}>
        Enter registry agent
      </button>
      <button type="button" onClick={props.onLocalConfiguration}>
        Use local command
      </button>
    </div>
  )) as never,
}));
vi.mock(import("./ProviderWizardAuthenticationStep"), async (original) => ({
  ...(await original()),
  ProviderWizardAuthenticationStep: (props: {
    environmentId: string;
    instanceId: string;
    autoOpenBrowser?: boolean;
    onFinish: () => void;
  }) => (
    <section aria-label="Sign-in step">
      {props.environmentId}/{props.instanceId}
      {props.autoOpenBrowser ? " opens the browser" : null}
      <button type="button" onClick={props.onFinish}>
        Finish sign-in
      </button>
    </section>
  ),
}));
vi.mock(import("./CodexSetupSection"), async (original) => ({
  ...(await original()),
  AddManagedCodexAccountDialog: ((props: { environmentId: string }) => (
    <section aria-label="ChatGPT sharing">{props.environmentId}</section>
  )) as never,
}));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

const remoteEnvironmentId = EnvironmentId.make("remote-device");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const dialog = () => (
  <AddProviderInstanceDialog
    open
    environmentId={remoteEnvironmentId}
    environmentLabel="Remote device"
    onOpenChange={actions.onOpenChange}
  />
);
const queryButton = (label: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
function button(label: string) {
  const found = queryButton(label);
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
const click = (label: string) => act(async () => button(label).click());
// Connection methods are named by their aria-label, which also carries the description.
function radio(name: string) {
  const found = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((element) =>
    (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().startsWith(name),
  );
  expect(found, `radio ${name}`).toBeDefined();
  return found!;
}
const choose = (name: string) => act(async () => radio(name).click());
const input = (selector: string) => {
  const found = document.querySelector<HTMLInputElement>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
};
async function type(selector: string, value: string) {
  await userEvent.fill(input(selector), value);
  await act(async () => input(selector).blur());
}
const signInStep = () => document.querySelector('[aria-label="Sign-in step"]');

async function useExistingCodexCli() {
  await click("Next");
  await choose("Use existing Codex CLI");
  await click("Continue");
}
async function chooseTraex() {
  await choose("Traex");
  await click("Next");
}

async function prepareCodexInstance() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(dialog()));
  await useExistingCodexCli();
  await type("#add-provider-label", "Work");
  await click("Next");
  stack.move();
  return screen;
}

function setup() {
  actions.canManageProviders = true;
  actions.toast.mockReset();
  actions.onOpenChange.mockReset();
  settingsHooks.read.mockReset().mockReturnValue({ providerInstances: {} });
  settingsHooks.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  settingsHooks.useMutation.mockReset().mockReturnValue(settingsHooks.mutate);
}

describe("AddProviderInstanceDialog environment routing", () => {
  it("creates a provider with its default identity without typing", async () => {
    setup();
    await using _screen = await render(dialog());
    const grok = [...document.querySelectorAll('[role="radio"]')].find((radio) =>
      radio.textContent?.includes("Grok"),
    ) as HTMLElement;
    await act(async () => grok.click());
    await click("Next");
    await click("Next");
    await click("Add instance");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "grok",
      instance: { driver: "grok", enabled: true, displayName: "Grok" },
    });
  });

  it("chooses an unused identity for another account without replacing configured instances", async () => {
    setup();
    settingsHooks.read.mockReturnValue({
      providerInstances: { codex_2: { driver: "codex", enabled: false } },
    });
    await using _screen = await render(dialog());
    await useExistingCodexCli();
    await click("Next");
    await click("Add instance");
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

  it("reads and writes settings through the supplied environment", async () => {
    setup();
    await using _screen = await render(dialog());

    expect(settingsHooks.read).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
  });

  it("keeps Codex connection choices separate from the provider catalog and remembers selection on Back", async () => {
    setup();
    await using _screen = await render(dialog());
    const steps = [
      ...document.querySelectorAll<HTMLButtonElement>('[aria-label="Setup progress"] button'),
    ];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((step) => step.disabled)).toBe(true);
    expect(document.querySelector("#add-provider-connection-label")).toBeNull();
    expect(queryButton("Use Kilo Code")).toBeDefined();

    await click("Next");
    expect(document.body.textContent).toContain("Connect Codex");
    expect(radio("Sign in with Codex CLI").getAttribute("aria-checked")).toBe("true");
    expect(radio("Use ChatGPT sharing").getAttribute("aria-label")).toBe(
      "Use ChatGPT sharing. Use your ChatGPT plan. Some Codex features are unavailable.",
    );
    expect(queryButton("Use Kilo Code")).toBeUndefined();

    await choose("Use existing Codex CLI");
    await click("Back");
    expect(document.querySelector("#add-provider-connection-label")).toBeNull();
    expect(queryButton("Use Kilo Code")).toBeDefined();
    await click("Next");
    expect(radio("Use existing Codex CLI").getAttribute("aria-checked")).toBe("true");
    expect(button("Continue").disabled).toBe(false);
  });

  it.each(["cli", "existing"] as const)(
    "creates a Claude %s account through its connection choice",
    async (choice) => {
      setup();
      await using _screen = await render(dialog());
      await choose("Claude");
      await click("Next");
      expect(radio("Sign in with Claude Code").getAttribute("aria-checked")).toBe("true");
      await choose(choice === "cli" ? "Sign in with Claude Code" : "Use existing Claude Code");
      await click("Continue");
      if (choice === "existing") await click("Next");
      await click(choice === "cli" ? "Continue to sign-in" : "Add instance");
      expect(settingsHooks.mutate).toHaveBeenCalledWith({
        operation: "create",
        instanceId: "claudeAgent_2",
        instance: {
          driver: "claudeAgent",
          enabled: true,
          displayName: "Claude",
          config: { setupMode: choice },
        },
      });
    },
  );

  it("opens ChatGPT sharing only after Continue", async () => {
    setup();
    const sharing = () => document.querySelector('[aria-label="ChatGPT sharing"]');
    await using _screen = await render(dialog());
    await click("Next");
    await choose("Use ChatGPT sharing");
    expect(sharing()).toBeNull();

    await click("Continue");
    expect(sharing()?.textContent).toBe("remote-device");
  });

  it("creates a native Codex account without runtime overrides and continues to sign-in", async () => {
    setup();
    await using _screen = await render(dialog());
    await click("Next");
    await click("Continue");
    await type("#add-provider-label", "Personal");
    await click("Continue to sign-in");
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
    expect(signInStep()?.textContent).toContain("remote-device/codex_personal opens the browser");
    expect(actions.onOpenChange).not.toHaveBeenCalled();
  });

  it("preserves the existing CLI configuration after leaving the native account path", async () => {
    setup();
    await using _screen = await render(dialog());
    await click("Next");
    await click("Continue");
    await click("Back");
    await choose("Use existing Codex CLI");
    await click("Continue");
    await click("Next");
    await click("Add instance");
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
    setup();
    settingsHooks.read.mockReturnValue({
      providerInstances: { codex_traex: { driver: "codex", enabled: true } },
    });
    await using _screen = await render(dialog());
    await chooseTraex();
    await click("Next");
    await click("Add instance");

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
    setup();
    await using _screen = await render(dialog());
    await chooseTraex();
    if (fixture.editConfig) {
      await click("Next");
      await type("#add-provider-codex-binaryPath", "/opt/codex");
      if (fixture.homePath !== undefined) {
        await type("#add-provider-codex-homePath", fixture.homePath);
      }
      await click("Back");
    }
    await type("#add-provider-instance-id", "traex_custom");
    await click("Next");
    await click("Add instance");

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
    setup();
    await using _screen = await render(dialog());
    await chooseTraex();
    await click("Next");
    await type("#add-provider-codex-homePath", "~/.traex-personal");
    await type("#add-provider-codex-homePath", "");
    await click("Back");
    await type("#add-provider-instance-id", "traex_final");
    await click("Next");
    await click("Add instance");

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
    setup();
    await using _screen = await render(dialog());
    await chooseTraex();
    await type("#add-provider-label", "Personal Traex");
    await type("#add-provider-instance-id", "traex_personal");
    await click("Next");
    await type("#add-provider-codex-binaryPath", "/opt/codex-personal");
    await type("#add-provider-codex-homePath", "~/.traex-personal");
    await type("#add-provider-codex-launchArgs", "--profile personal");
    await click("Back");
    await click("Back");
    await chooseTraex();
    await click("Next");
    await click("Add instance");

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
    setup();
    await using _screen = await render(dialog());
    await useExistingCodexCli();
    await type("#add-provider-label", "Work");
    await click("Next");
    await type("#add-provider-codex-binaryPath", "/opt/codex");
    await type("#add-provider-codex-homePath", "~/.codex-work");
    await click("Back");
    await click("Back");
    await click("Back");
    await chooseTraex();
    await click("Back");
    await choose("Codex");
    await click("Next");
    await click("Continue");
    await click("Next");
    await click("Add instance");

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
    setup();
    const mutation = deferred<{ readonly _tag: "Success"; readonly value: unknown }>();
    settingsHooks.mutate.mockReturnValueOnce(mutation.promise);
    await using _screen = await render(dialog());
    await click("Use Kilo Code");

    expect(document.body.textContent).toContain("v4.2.0 · binary");
    await click("Continue to sign-in");
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
    expect(signInStep()).toBeNull();

    await act(async () => mutation.resolve({ _tag: "Success", value: {} }));
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(signInStep()?.textContent).toContain("remote-device/acpRegistry_kilo_code");
    expect(settingsHooks.mutate).toHaveBeenCalledTimes(1);
    await click("Finish sign-in");
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("configures a manually entered registry agent from the first provider screen", async () => {
    setup();
    await using _screen = await render(dialog());
    await click("Enter registry agent");
    await type("#add-provider-acpRegistry-manual-agentId", "devin");
    await click("Next");
    await click("Continue to sign-in");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_custom",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        config: { agentId: "devin" },
      },
    });
    expect(signInStep()).not.toBeNull();
  });

  it("creates a local command in the selected environment without a sign-in step", async () => {
    setup();
    await using _screen = await render(dialog());
    await click("Use local command");
    await click("Next");
    expect(document.body.textContent).toContain("Executable is required.");
    expect(settingsHooks.mutate).not.toHaveBeenCalled();

    await type("#add-provider-acpRegistry-manual-commandPath", "dsh");
    const commandArgs = ["--profile", "acp", " literal $(value) ; ", ""];
    for (const [index, argument] of commandArgs.entries()) {
      await click("Add argument");
      if (argument) await type(`input[aria-label="Argument ${index + 1}"]`, argument);
    }
    await click("Add variable");
    await type('input[aria-label="Environment variable name 1"]', "DSH_PROFILE");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Mark environment variable DSH_PROFILE as sensitive"]',
        )!
        .click(),
    );
    await type('input[aria-label="Environment variable value 1"]', "work");
    await click("Next");
    await type("#add-provider-label", "Deepseek Harness");
    await click("Add instance");

    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_deepseek_harness",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "Deepseek Harness",
        config: { source: "local", commandPath: "dsh", commandArgs },
        environment: [
          expect.objectContaining({ name: "DSH_PROFILE", value: "work", sensitive: false }),
        ],
      },
    });
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
    expect(signInStep()).toBeNull();
  });

  it("keeps the dialog open when the atomic upsert fails", async () => {
    setup();
    settingsHooks.mutate.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Conflict") });
    await using _screen = await render(dialog());
    await click("Use Kilo Code");
    await click("Continue to sign-in");

    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(actions.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Could not add provider instance" }),
    );
    expect(button("Continue to sign-in").disabled).toBe(false);
  });

  it("adds an instance with the selected environment's provider grant alone", async () => {
    setup();
    await using _screen = await prepareCodexInstance();
    await click("Add instance");

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

  it("rejects a queued save after the provider grant is revoked", async () => {
    setup();
    await using screen = await prepareCodexInstance();
    const save = button("Add instance");
    actions.canManageProviders = false;
    // The rendered button is still enabled; the click must recheck the live grant.
    await act(async () => save.click());

    expect(settingsHooks.mutate).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    await screen.rerender(dialog());
    expect(button("Add instance").disabled).toBe(true);
  });

  it("keeps a denied draft available when the provider grant arrives", async () => {
    setup();
    actions.canManageProviders = false;
    await using screen = await prepareCodexInstance();
    expect(button("Add instance").disabled).toBe(true);
    expect(settingsHooks.mutate).not.toHaveBeenCalled();

    actions.canManageProviders = true;
    await screen.rerender(dialog());
    expect(button("Add instance").disabled).toBe(false);
    await click("Add instance");
    expect(settingsHooks.mutate).toHaveBeenCalledOnce();
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });
});
