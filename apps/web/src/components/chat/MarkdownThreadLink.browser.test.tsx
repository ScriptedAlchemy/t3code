import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { threadFamilies } from "../../state/threads";
import { MarkdownThreadLink } from "./MarkdownThreadLink";
import "../../index.css";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("thread:delegated-task:command%3Amcp%3Achild");
const child = { environmentId, id: threadId, title: "Code store foundation" };
const familyLoaded = Atom.make(false);

vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
  useThreadShell: (ref: ScopedThreadRef | null) => {
    const loaded = useAtomValue(familyLoaded);
    return loaded && ref?.environmentId === environmentId && ref.threadId === threadId
      ? child
      : null;
  },
  useThreadRefs: () => [],
  useProject: () => null,
}));

it("opens a cited idle child's literal ID and keeps its title until the citation unmounts", async () => {
  using _family = vi.spyOn(threadFamilies, "mount").mockImplementation((registry, env, id) => {
    if (env !== environmentId || id !== threadId) return () => {};
    registry.set(familyLoaded, true);
    return () => registry.set(familyLoaded, false);
  });
  await using screen = await render(
    <RegistryContext value={appAtomRegistry}>
      <p>
        The repairs are verified in{" "}
        <MarkdownThreadLink
          environmentId={environmentId}
          link={{ environmentId, threadId }}
          label={null}
        />
        .
      </p>
    </RegistryContext>,
  );
  const link = screen.getByRole("link", { name: "Thread, Code store foundation" });
  await expect.element(link).toHaveAttribute("href", `/local/${encodeURIComponent(threadId)}`);
  await screen.unmount();
  expect(appAtomRegistry.get(familyLoaded)).toBe(false);
});
