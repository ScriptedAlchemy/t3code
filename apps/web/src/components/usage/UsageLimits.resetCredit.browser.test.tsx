import { createRef, useImperativeHandle } from "react";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render.tsx";

const mocks = vi.hoisted(() => ({ consume: vi.fn(), canManage: vi.fn() }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: mocks.canManage,
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { consumeResetCredit: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.consume }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: vi.fn() }));
vi.mock("../../state/presentation", () => ({ environmentPresentations: {} }));
vi.mock("./UsageLimitsPooled", () => ({ UsageLimitsPooled: () => null }));

import { useResetCredit } from "./UsageLimits";

const environmentId = EnvironmentId.make("reset-environment");
const input = { instanceId: ProviderInstanceId.make("codex") };
const success = { _tag: "Success", value: { outcome: "reset" } } as const;
type Result = typeof success | { readonly _tag: "Failure"; readonly cause: { error: Error } };

function setup() {
  mocks.consume.mockReset().mockResolvedValue(success);
  mocks.canManage.mockReset().mockReturnValue(true);
  const ref = createRef<ReturnType<typeof useResetCredit>>();
  function Probe() {
    const value = useResetCredit(environmentId, input);
    useImperativeHandle(ref, () => value);
    return null;
  }
  return {
    Probe,
    get value() {
      if (ref.current === null) throw new Error("Reset-credit hook was not mounted");
      return ref.current;
    },
  };
}

it.each(["success", "failure", "rejection"] as const)(
  "coalesces overlapping redemptions and permits a new attempt after %s",
  async (outcome) => {
    const fixture = setup();
    await using _screen = await render(<fixture.Probe />);
    let resolve!: (value: Result) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<Result>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    const pending = { promise, resolve, reject };
    mocks.consume.mockReturnValueOnce(pending.promise);
    const attempts: Array<ReturnType<typeof fixture.value.redeem>> = [];
    await act(() => {
      attempts.push(fixture.value.redeem(), fixture.value.redeem());
    });
    expect(mocks.consume).toHaveBeenCalledTimes(1);
    expect(mocks.consume).toHaveBeenCalledWith({ environmentId, input });
    expect(await attempts[1]).toBeUndefined();
    expect(fixture.value.busy).toBe(true);

    const message =
      outcome === "success"
        ? "Reset applied. Your windows have cleared."
        : outcome === "failure"
          ? "Denied"
          : "Could not use the reset credit.";
    await act(async () => {
      if (outcome === "rejection") pending.reject(new Error("Disconnected"));
      else if (outcome === "failure") {
        pending.resolve({ _tag: "Failure", cause: { error: new Error("Denied") } });
      } else pending.resolve(success);
      expect(await attempts[0]).toEqual({ reset: outcome === "success", message });
    });
    expect(fixture.value.busy).toBe(false);
    expect(fixture.value.status).toBe(message);

    mocks.canManage.mockReturnValue(false);
    await act(async () => {
      expect(await fixture.value.redeem()).toBeUndefined();
    });
    expect(mocks.consume).toHaveBeenCalledTimes(1);
    mocks.canManage.mockReturnValue(true);
    await act(async () => {
      expect(await fixture.value.redeem()).toEqual({
        reset: true,
        message: "Reset applied. Your windows have cleared.",
      });
    });
    expect(mocks.consume).toHaveBeenCalledTimes(2);
    expect(fixture.value.busy).toBe(false);
  },
);
