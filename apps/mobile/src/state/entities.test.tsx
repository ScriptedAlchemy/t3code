import { RegistryContext } from "@effect/atom-react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

vi.mock("./atom-registry", () => ({ appAtomRegistry: AtomRegistry.make() }));
vi.mock("./projects", () => ({ environmentProjects: {} }));
vi.mock("./server", () => ({
  environmentServerConfigsAtom: Atom.make(new Map()),
  serverEnvironment: {},
}));
vi.mock("./assets", () => ({ projectFaviconUrlAtom: vi.fn() }));
vi.mock("../native/ProjectChipIconImages", () => ({
  projectGlyphImageAtom: vi.fn(),
  projectGlyphKey: vi.fn(),
}));
vi.mock("./threads", () => {
  const shell = Atom.make<{ title: string } | null>(null);
  const absent = Atom.make(null);
  return {
    environmentThreadDetails: {},
    environmentThreadShells: {
      threadShellAtom: (ref: ScopedThreadRef) => (ref.threadId === childId ? shell : absent),
    },
    threadFamilies: {
      mount: (registry: AtomRegistry.AtomRegistry, _env: EnvironmentId, id: ThreadId) => {
        if (id !== childId) return () => {};
        registry.set(shell, { title: "Child result" });
        return () => registry.set(shell, null);
      },
    },
  };
});

import { appAtomRegistry } from "./atom-registry";
import { resolveThreadLink, useLiveThreadLinkLabels } from "./entities";
import { environmentThreadShells } from "./threads";

const childId = ThreadId.make("thread:delegated-task:command%3Amcp%3Achild");

it("keeps a linked child title mounted until the message stops citing it", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  let renders = 0;
  function Probe({ text }: { text: string }) {
    if (++renders > 20) throw new Error("Thread title subscription loop");
    return useLiveThreadLinkLabels(text, EnvironmentId.make("local"));
  }
  try {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <Probe text={`<t3-thread://v2/local/${childId}>`} />
        </RegistryContext.Provider>,
      ),
    );
    expect(container.textContent).toBe(`[Child result](t3-thread://v2/local/${childId})`);
    const target = { environmentId: EnvironmentId.make("local"), threadId: childId };
    expect(
      resolveThreadLink((atom) => appAtomRegistry.get(atom), target, target.environmentId),
    ).toEqual(target);
    expect(renders).toBeLessThan(20);
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <Probe text="No link" />
        </RegistryContext.Provider>,
      ),
    );
    expect(container.textContent).toBe("No link");
    expect(
      appAtomRegistry.get(
        environmentThreadShells.threadShellAtom({
          environmentId: EnvironmentId.make("local"),
          threadId: childId,
        }),
      ),
    ).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
