import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import type { ConfirmDialogRequest } from "../../components/ui/Dialog.types";

const mocks = vi.hoisted(() => ({
  canUnlink: true,
  confirm: vi.fn<(request: ConfirmDialogRequest) => void>(),
  alert: vi.fn(),
  unlink: vi.fn(),
  refresh: vi.fn(),
  error: null as string | null,
  links: [] as PeerLinkSummary[],
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  AppState: {},
}));
vi.mock("@react-navigation/native", () => ({ useFocusEffect: () => {} }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("@t3tools/client-runtime/link-request", () => ({ offersLinkedEnvironments: () => true }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ confirm: mocks.confirm, alert: mocks.alert }));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../../state/entities", () => ({ useEnvironmentServerConfig: () => ({}) }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/peerLinks", () => ({
  peerLinkEnvironment: {
    list: () => ({}),
    unlink: { permissionAtom: () => mocks.canUnlink },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.unlink }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { links: mocks.links },
    error: mocks.error,
    refresh: mocks.refresh,
  }),
}));

import { LinkedEnvironmentsSection } from "./LinkedEnvironmentsSection";

it("lets mobile users forget an agent link only after confirmation and with destination-scoped permissions", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.canUnlink = true;
  mocks.error = null;
  mocks.confirm.mockClear();
  mocks.unlink.mockReset();
  mocks.links = [
    {
      environmentId: EnvironmentId.make("destination"),
      label: "Build machine",
      urls: ["https://build.example.com"],
      access: "approval-required",
      linkedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
      expiresAt: DateTime.makeUnsafe("2099-10-01T00:00:00Z"),
      lastReachedAt: null,
      lastError: null,
      status: "reachable",
    },
  ];
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <LinkedEnvironmentsSection
          environmentId={EnvironmentId.make("origin")}
          environmentLabel="Origin"
        />,
      ),
    );
    const forget = container.querySelector<HTMLButtonElement>("button");
    expect(forget).not.toBeNull();
    act(() => forget!.click());
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.confirm.mock.lastCall?.[0].message).toContain("Revoke");
    expect(mocks.confirm.mock.lastCall?.[0].message).toContain("Build machine");

    let resolve!: (value: ReturnType<typeof AsyncResult.success>) => void;
    mocks.unlink.mockReturnValueOnce(
      new Promise((finish) => {
        resolve = finish;
      }),
    );
    act(() => mocks.confirm.mock.lastCall![0].onConfirm());
    expect(forget!.disabled).toBe(true);
    expect(mocks.unlink).toHaveBeenCalledWith({
      environmentId: "origin",
      input: { environmentId: "destination" },
    });
    await act(async () => resolve(AsyncResult.success({ removed: true })));
    expect(forget!.disabled).toBe(false);

    mocks.canUnlink = false;
    act(() =>
      root.render(
        <LinkedEnvironmentsSection
          key="read-only"
          environmentId={EnvironmentId.make("origin")}
          environmentLabel="Origin"
        />,
      ),
    );
    expect(container.querySelector("button")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it("keeps a failed link read visible and lets the user retry", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.links = [];
  mocks.error = "The environment is reconnecting.";
  mocks.refresh.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <LinkedEnvironmentsSection
          environmentId={EnvironmentId.make("origin")}
          environmentLabel="Origin"
        />,
      ),
    );
    expect(container.textContent).toContain(mocks.error);
    const retry = container.querySelector<HTMLButtonElement>("button");
    expect(retry).not.toBeNull();
    act(() => retry!.click());
    expect(mocks.refresh).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});
