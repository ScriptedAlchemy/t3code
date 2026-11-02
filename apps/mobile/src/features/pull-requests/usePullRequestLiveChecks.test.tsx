import { RegistryContext } from "@effect/atom-react";
import type { PullRequestChecks, PullRequestDetail } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  active: "active",
  focused: true,
  reads: 0,
  appListeners: new Set<() => void>(),
  focusListeners: new Set<() => void>(),
  query: null as Atom.Atom<AsyncResult.AsyncResult<PullRequestChecks, never>> | null,
}));

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return fixture.active;
    },
    addEventListener: (_event: string, listener: () => void) => {
      fixture.appListeners.add(listener);
      return { remove: () => fixture.appListeners.delete(listener) };
    },
  },
}));
vi.mock("@react-navigation/native", async () => {
  const { useEffect, useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    fixture.focusListeners.add(listener);
    return () => fixture.focusListeners.delete(listener);
  };
  const useIsFocused = () => useSyncExternalStore(subscribe, () => fixture.focused);
  return {
    useIsFocused,
    useFocusEffect: (effect: () => (() => void) | undefined) => {
      const focused = useIsFocused();
      useEffect(() => (focused ? effect() : undefined), [effect, focused]);
    },
  };
});
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => ({
    environment: { capabilities: { pullRequestChecks: true } },
  }),
}));
vi.mock("../../state/pull-requests", () => ({
  composerPullRequests: { checks: () => fixture.query },
}));
vi.mock("./usePullRequestConnected", () => ({ usePullRequestConnected: () => true }));
vi.mock("./usePullRequestDiff", () => ({ pullRequestTarget: (params: unknown) => params }));

import { usePullRequestLiveChecks } from "./usePullRequestLiveChecks";

function setup(active = "active") {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(0);
  fixture.active = active;
  fixture.focused = true;
  fixture.reads = 0;
  fixture.appListeners.clear();
  fixture.focusListeners.clear();
  fixture.query = Atom.make(
    Effect.sync(() => {
      fixture.reads++;
      return { state: "open" as const, checks: [], headSha: "head", observedAt: fixture.reads };
    }),
  ).pipe(Atom.setIdleTTL(0));
  const registry = AtomRegistry.make();
  const root = createRoot(document.createElement("div"));
  const detail = { state: "open", checks: [], observedAt: 0 } as unknown as PullRequestDetail;
  function Probe() {
    usePullRequestLiveChecks(
      { environmentId: "local", projectId: "project", repository: "acme/app", number: 7 },
      detail,
    );
    return null;
  }
  act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    ),
  );
  return {
    active(state: string) {
      act(() => {
        fixture.active = state;
        for (const listener of fixture.appListeners) listener();
      });
    },
    focused(focused: boolean) {
      act(() => {
        fixture.focused = focused;
        for (const listener of fixture.focusListeners) listener();
      });
    },
    async advance(milliseconds: number) {
      await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
      vi.useRealTimers();
    },
  };
}

it("polls only the foreground focused route and resumes one checks subscription", async () => {
  using screen = setup();
  expect(fixture.reads).toBe(1);
  await screen.advance(45_000);
  expect(fixture.reads).toBe(2);
  screen.active("background");
  await screen.advance(180_000);
  expect(fixture.reads).toBe(2);
  screen.active("active");
  expect(fixture.reads).toBe(3);
  await screen.advance(45_000);
  expect(fixture.reads).toBe(4);
  screen.focused(false);
  await screen.advance(180_000);
  expect(fixture.reads).toBe(4);
  screen.focused(true);
  expect(fixture.reads).toBe(5);
});

it("does not subscribe to checks when the route first mounts in the background", async () => {
  using screen = setup("background");
  await screen.advance(180_000);
  expect(fixture.reads).toBe(0);
  screen.active("active");
  expect(fixture.reads).toBe(1);
});
