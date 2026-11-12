import { createRef, useImperativeHandle } from "react";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ consume: vi.fn(), canManage: vi.fn() }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: { consumeResetCredit: {} } }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: mocks.canManage,
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.consume }));

import * as Dialog from "../../components/ui/Dialog";
import { useResetCredit } from "./useResetCredit";

const environmentId = EnvironmentId.make("reset-environment");
const input = { instanceId: ProviderInstanceId.make("codex") };
const success = { _tag: "Success", value: { outcome: "reset" } } as const;
type Result = typeof success | { readonly _tag: "Failure"; readonly cause: { error: Error } };

function setup() {
  mocks.consume.mockReset().mockResolvedValue(success);
  mocks.canManage.mockReset().mockReturnValue(true);
  vi.mocked(Dialog.alert).mockClear();
  const root = createRoot(document.createElement("div"));
  const ref = createRef<ReturnType<typeof useResetCredit>>();
  function Probe() {
    const value = useResetCredit(environmentId, input);
    useImperativeHandle(ref, () => value);
    return null;
  }
  act(() => root.render(<Probe />));
  return {
    get value() {
      if (ref.current === null) throw new Error("Reset-credit hook was not mounted");
      return ref.current;
    },
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

function approval() {
  const action = vi
    .mocked(Dialog.alert)
    .mock.lastCall?.[2]?.find((button) => button.text === "Use credit")?.onPress;
  if (action === undefined) throw new Error("Missing reset-credit confirmation");
  return action;
}

it.each(["success", "failure", "rejection"] as const)(
  "coalesces overlapping approvals and permits a new attempt after %s",
  async (outcome) => {
    using fixture = setup();
    let resolve!: (value: Result) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<Result>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    const pending = { promise, resolve, reject };
    mocks.consume.mockReturnValueOnce(pending.promise);
    fixture.value.confirm();
    const first = approval();
    fixture.value.confirm();
    const second = approval();
    act(() => {
      first();
      second();
    });
    expect(mocks.consume).toHaveBeenCalledTimes(1);
    expect(mocks.consume).toHaveBeenCalledWith({ environmentId, input });
    expect(fixture.value.busy).toBe(true);
    const prompts = vi.mocked(Dialog.alert).mock.calls.length;
    fixture.value.confirm();
    expect(Dialog.alert).toHaveBeenCalledTimes(prompts);

    await act(async () => {
      if (outcome === "rejection") pending.reject(new Error("Disconnected"));
      else if (outcome === "failure") {
        pending.resolve({ _tag: "Failure", cause: { error: new Error("Denied") } });
      } else pending.resolve(success);
      await pending.promise.catch(() => undefined);
    });
    expect(fixture.value.busy).toBe(false);
    expect(fixture.value.status).toBe(
      outcome === "success"
        ? "Reset applied. Your windows have cleared."
        : outcome === "failure"
          ? "Denied"
          : "Could not use the reset credit.",
    );
    await act(async () => {
      fixture.value.confirm();
      approval()();
    });
    expect(mocks.consume).toHaveBeenCalledTimes(2);
    expect(fixture.value.busy).toBe(false);
  },
);

it("rechecks management permission after the confirmation opens", () => {
  using fixture = setup();
  fixture.value.confirm();
  const confirm = approval();
  mocks.canManage.mockReturnValue(false);
  act(() => confirm());
  expect(mocks.consume).not.toHaveBeenCalled();
  expect(fixture.value.busy).toBe(false);
});

it("redeems the confirmed choice's credit", async () => {
  using fixture = setup();
  const choiceInput = { ...input, creditId: "fable" };
  fixture.value.confirm({ input: choiceInput, confirmDescription: "Fable reset." });
  expect(vi.mocked(Dialog.alert).mock.lastCall?.[1]).toBe("Fable reset.");
  await act(async () => approval()());
  expect(mocks.consume).toHaveBeenCalledWith({ environmentId, input: choiceInput });
});
