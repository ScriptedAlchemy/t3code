import { RegistryContext } from "@effect/atom-react";
import type { ThreadGroup } from "@t3tools/client-runtime/state/thread-group";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AtomRegistry, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  remove: vi.fn(),
  end: vi.fn(),
  invite: vi.fn(),
  canInvite: true,
}));

vi.mock(import("~/state/orchestration"), async (original) => {
  const actual = await original();
  const permitted = (command: object, run: ReturnType<typeof vi.fn>) =>
    Object.assign(command, { run, permissionAtom: () => Atom.make(true) });
  return {
    ...actual,
    orchestrationEnvironment: {
      ...actual.orchestrationEnvironment,
      removeFromGroup: permitted(actual.orchestrationEnvironment.removeFromGroup, state.remove),
      endGroup: permitted(actual.orchestrationEnvironment.endGroup, state.end),
    },
  } as never;
});
vi.mock(import("./groupAvailability"), async (original) => ({
  ...(await original()),
  useCanInviteToGroup: () => state.canInvite,
  requestGroupInvite: state.invite,
}));

import { GroupRosterBar } from "./GroupRosterBar";

const environmentId = EnvironmentId.make("env");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
const astra = ThreadId.make("astra-thread");
const opus = ThreadId.make("opus-thread");

const group = (patch: Partial<ThreadGroup> = {}): ThreadGroup => ({
  status: "active",
  primary: { model: "fable-5", label: "Fable", handle: "fable" },
  seats: [
    { threadId: astra, handle: "astra", label: "Astra", status: "seated", joinedAfterRun: 0 },
    { threadId: opus, handle: "opus", label: "Opus", status: "left", joinedAfterRun: 0 },
  ],
  discussion: null,
  closedBecause: null,
  closedAt: null,
  ...patch,
});

async function renderBar(value: ThreadGroup) {
  const registry = AtomRegistry.make();
  return render(
    <RegistryContext value={registry}>
      <GroupRosterBar threadRef={threadRef} group={value} />
    </RegistryContext>,
    { router: false },
  );
}

it("lists the primary and seated peers, and removes or ends from the roster", async () => {
  state.remove.mockReset().mockResolvedValue({ _tag: "Success" });
  state.end.mockReset().mockResolvedValue({ _tag: "Success" });
  state.canInvite = true;
  await using screen = await renderBar(group());
  expect(screen.container.textContent).toContain("Fable, primary");
  expect(screen.container.textContent).not.toContain("Opus");

  await userEvent.click(screen.getByRole("button", { name: "Astra, group member" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Remove" }));
  expect(state.remove).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.objectContaining({
      environmentId,
      input: { threadId: threadRef.threadId, seatThreadId: astra },
    }),
  );

  await userEvent.click(screen.getByRole("button", { name: "End group · Continue with Fable" }));
  expect(state.end).toHaveBeenCalledTimes(1);
});

it("offers Invite only while Group conversations is on, and says when a budget closed", async () => {
  state.canInvite = false;
  {
    await using screen = await renderBar(group({ closedBecause: "budget" }));
    expect(screen.container.querySelector('[aria-label="Invite a model"]')).toBeNull();
    await expect
      .element(screen.getByText("A member has unanswered replies. Any message continues."))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "End group · Continue with Fable" }))
      .toBeEnabled();
  }
  state.canInvite = true;
  await using screen = await renderBar(group());
  await userEvent.click(screen.getByRole("button", { name: "Invite a model" }));
  expect(state.invite).toHaveBeenCalledWith(threadRef);
});
