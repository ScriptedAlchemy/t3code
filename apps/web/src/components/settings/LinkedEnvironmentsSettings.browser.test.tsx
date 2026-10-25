import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, PeerLinkError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ link: vi.fn(), toast: vi.fn() }));

vi.mock(import("../../state/peerLinks"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    peerLinkEnvironment: {
      ...actual.peerLinkEnvironment,
      link: {
        ...actual.peerLinkEnvironment.link,
        run: state.link,
        permissionAtom: () => Atom.make(true),
      },
    },
    useLinkableMachines: () => [],
  };
});
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: { links: [] }, error: null })) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  usePreparedConnection: () => Option.none(),
  useEnvironmentScope: () => false,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import { LinkedEnvironmentsSettings } from "./LinkedEnvironmentsSettings";

it.each(["failure", "defect"] as const)(
  "keeps a pairing request's %s out of console and error toasts",
  async (kind) => {
    const pairingCode = "test-pairing-secret";
    const failure = new PeerLinkError({
      reason: "pairing_rejected",
      message: `The peer could not process pairingCode=${pairingCode}`,
      cause: { request: { decision: { _tag: "pairing-code", code: pairingCode } } },
    });
    state.link
      .mockReset()
      .mockResolvedValue(
        AsyncResult.failure(kind === "failure" ? Cause.fail(failure) : Cause.die(failure)),
      );
    state.toast.mockReset();
    using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    using error = vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = AtomRegistry.make();
    try {
      await using screen = await render(
        <RegistryContext value={registry}>
          <LinkedEnvironmentsSettings
            environmentId={EnvironmentId.make("source")}
            environmentLabel="Source"
            isSearchTarget={false}
          />
        </RegistryContext>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Link", exact: true }));
      const dialog = page.getByRole("dialog", { name: "Link an environment" });
      await userEvent.fill(dialog.getByRole("textbox", { name: "Address" }), "https://box.ts.net");
      await userEvent.fill(dialog.getByRole("textbox", { name: "Pairing code" }), pairingCode);
      await userEvent.keyboard("{Enter}");

      expect(state.link).toHaveBeenCalledExactlyOnceWith(
        registry,
        expect.objectContaining({ input: expect.objectContaining({ pairingCode }) }),
      );
      expect(state.toast).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          title: "Could not link the environment",
          description: "Could not answer the request. Try again.",
        }),
      );
      expect(
        warn.mock.calls.filter(([message]) => String(message).startsWith("[atom-command]")),
      ).toEqual([]);
      expect(
        error.mock.calls.filter(([message]) => String(message).startsWith("[atom-command]")),
      ).toEqual([]);
    } finally {
      registry.dispose();
    }
  },
);
