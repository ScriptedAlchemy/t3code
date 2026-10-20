import type { AccountSyncEnvironment } from "@t3tools/client-runtime/state/provider-account-sync";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { syncDestinationChoice, syncResultRow } from "./providerAccountSync.logic";

const instanceId = ProviderInstanceId.make("claude");
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");

const capable = { environment: { capabilities: { providerAccountTransfer: true } } } as const;

function environment(
  id: string,
  overrides: Partial<AccountSyncEnvironment> = {},
): AccountSyncEnvironment {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: { phase: "connected" },
    serverConfig: capable,
    canManageProviders: true,
    settings: DEFAULT_SERVER_SETTINGS,
    providers: [],
    ...overrides,
  };
}

function withInstance(driver: ProviderDriverKind): AccountSyncEnvironment["settings"] {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: { [instanceId]: { driver } },
  };
}

const source = environment("laptop", { settings: withInstance(claude) });

describe("syncDestinationChoice", () => {
  it("offers a connected, capable, writable destination without a note when the account is new", () => {
    expect(
      syncDestinationChoice({ source, destination: environment("desktop"), instanceId }),
    ).toEqual({
      environmentId: EnvironmentId.make("desktop"),
      label: "desktop",
      disabled: false,
      note: null,
    });
  });

  it("says an existing copy is updated and who it is signed in as", () => {
    const destination = environment("desktop", {
      settings: withInstance(claude),
      providers: [
        {
          instanceId,
          driver: claude,
          auth: { status: "authenticated", email: "me@example.com" },
        } as ServerProvider,
      ],
    });
    expect(syncDestinationChoice({ source, destination, instanceId })).toMatchObject({
      disabled: false,
      note: "Updates the copy on desktop (signed in as me@example.com).",
    });
  });

  it.each([
    [{ connection: { phase: "connecting" } }, "desktop isn't connected."],
    [{ serverConfig: null }, "Update desktop to sync accounts."],
    [{ canManageProviders: false }, "This connection can't manage providers on desktop."],
    [{ settings: withInstance(codex) }, "desktop uses this account's ID for another provider."],
  ] as const)("blocks %j with a reason", (overrides, note) => {
    const destination = environment("desktop", overrides as Partial<AccountSyncEnvironment>);
    expect(syncDestinationChoice({ source, destination, instanceId })).toMatchObject({
      disabled: true,
      note,
    });
  });

  it("blocks every destination when the source cannot be exported", () => {
    const readOnlySource = environment("laptop", {
      settings: withInstance(claude),
      canManageProviders: false,
    });
    expect(
      syncDestinationChoice({
        source: readOnlySource,
        destination: environment("desktop"),
        instanceId,
      }),
    ).toMatchObject({
      disabled: true,
      note: "This connection can't manage providers on laptop.",
    });
  });
});

describe("syncResultRow", () => {
  const base = {
    accountLabel: "Claude",
    sourceLabel: "laptop",
    destinationLabel: "desktop",
    destinationProvider: undefined,
  };
  const key = { instanceId, destinationEnvironmentId: EnvironmentId.make("desktop") };

  it("names the missing sign-in on a synced copy and keeps omitted settings visible", () => {
    const row = syncResultRow({
      ...base,
      cell: {
        ...key,
        status: "synced",
        change: "created",
        omitted: [
          { reason: "machine-local", setting: { _tag: "ConfigField", field: "binaryPath" } },
        ],
      },
      destinationProvider: {
        driver: claude,
        installed: true,
        enabled: true,
        status: "warning",
        message: undefined,
        auth: { status: "unauthenticated" },
        setup: { canAuthenticate: true },
      } as ServerProvider,
    });
    expect(row).toMatchObject({
      title: "Claude on desktop",
      description: "Sign in on desktop to finish. Stays on laptop: binaryPath.",
      tone: "default",
    });
  });

  it("shows a synced copy the destination has not listed yet as starting", () => {
    const row = syncResultRow({
      ...base,
      cell: { ...key, status: "synced", change: "created", omitted: [] },
    });
    expect(row.description).toBe("Starting on desktop.");
  });

  it("blames the end that blocked a skipped cell", () => {
    expect(
      syncResultRow({
        ...base,
        cell: { ...key, status: "skipped", end: "source", reason: "update-required" },
      }).description,
    ).toBe("Update laptop to sync accounts.");
    expect(
      syncResultRow({
        ...base,
        cell: { ...key, status: "skipped", end: "destination", reason: "not-connected" },
      }).description,
    ).toBe("desktop isn't connected.");
  });

  it("shows a failure's message as an error", () => {
    expect(
      syncResultRow({
        ...base,
        cell: { ...key, status: "failed", stage: "import", message: "Disk is full." },
      }),
    ).toMatchObject({ description: "Disk is full.", tone: "danger" });
  });
});
