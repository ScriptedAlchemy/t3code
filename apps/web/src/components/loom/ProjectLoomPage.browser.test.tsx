import "../../index.css";
import { RegistryContext } from "@effect/atom-react";
import {
  CheckpointId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type LoomWindow,
  type LoomWindowInput,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { useDiffPanelStore } from "../../diffPanelStore";
import type { LoomSearch } from "./loomSearch";

const state = vi.hoisted(() => ({
  config: null as unknown,
  windows: new Map<string, unknown>(),
  respond: (_input: unknown): unknown => null,
}));
vi.mock(
  import("../../state/server"),
  () => ({ serverEnvironment: { configValueAtom: () => state.config } }) as never,
);
vi.mock(
  import("../../state/projectLoom"),
  () =>
    ({
      projectLoom: {
        window: (target: { input: unknown }) => {
          const key = JSON.stringify(target.input);
          if (!state.windows.has(key)) state.windows.set(key, state.respond(target.input));
          return state.windows.get(key);
        },
      },
    }) as never,
);
vi.mock(import("../../state/entities"), () => ({ useProject: () => null }) as never);
vi.mock(
  import("../../lib/openPullRequestLink"),
  () => ({ useOpenPrLink: () => () => false }) as never,
);

import { ProjectLoomPage } from "./ProjectLoomPage";

const environmentId = EnvironmentId.make("loom-browser");
const projectId = ProjectId.make("project");
const instanceId = ProviderInstanceId.make("codex");
const from = "2026-10-16T00:00:00.000Z";
const to = "2026-10-23T00:00:00.000Z";
const rootId = ThreadId.make("root-thread");
const childId = ThreadId.make("child-thread");
const otherId = ThreadId.make("billing-thread");
const runId = RunId.make("root-run");

const lane = (threadId: ThreadId, title: string, parent: ThreadId | null) => ({
  threadId,
  title,
  relationship: parent === null ? ("root" as const) : ("subagent" as const),
  parentThreadId: parent,
  providerInstanceId: instanceId,
  model: "gpt-5",
  branch: "main",
  createdAt: "2026-10-20T00:00:00.000Z",
  archivedAt: null,
});

const fullWindow: LoomWindow = {
  projectId,
  asOf: to,
  from,
  to,
  lanes: [
    lane(rootId, "Fix login", null),
    lane(childId, "Explore auth module", rootId),
    lane(otherId, "Add billing", null),
  ],
  ancestors: [],
  runs: [
    {
      id: runId,
      threadId: rootId,
      ordinal: 1,
      status: "completed",
      providerInstanceId: instanceId,
      model: "gpt-5",
      userMessageId: MessageId.make("message"),
      requestedAt: "2026-10-20T10:00:00.000Z",
      startedAt: "2026-10-20T10:01:00.000Z",
      completedAt: "2026-10-20T12:00:00.000Z",
    },
  ],
  markers: [
    {
      kind: "checkpoint",
      id: CheckpointId.make("checkpoint"),
      threadId: rootId,
      runId,
      at: "2026-10-20T12:00:00.000Z",
      status: "ready",
      fileCount: 2,
      additions: 13,
      deletions: 1,
    },
  ],
  edges: [],
  truncated: {
    lanes: false,
    ancestors: false,
    runs: true,
    markers: false,
    edges: false,
    bytes: false,
  },
  coverage: { untimedTasks: 0, commandsScanned: 0, commandsTruncated: false },
  nextCursor: null,
};

function setup() {
  state.config = Atom.make({ environment: { capabilities: { projectLoom: true } } });
  state.windows.clear();
  state.respond = (input) => {
    const title = (input as LoomWindowInput).filters?.title?.toLowerCase();
    const window =
      title === undefined
        ? fullWindow
        : {
            ...fullWindow,
            lanes: fullWindow.lanes.filter((entry) => entry.title.toLowerCase().includes(title)),
          };
    return Atom.make(AsyncResult.success(window));
  };
  useDiffPanelStore.setState({ byThreadKey: {} });
  return AtomRegistry.make();
}

function LoomHarness() {
  const [search, setSearch] = useState<LoomSearch>({ from, to });
  return (
    <ProjectLoomPage
      environmentId={environmentId}
      projectId={projectId}
      search={search}
      onSearchChange={(update) => setSearch(update)}
    />
  );
}

const lanes = () => page.getByTestId("loom-lane");

it("nests and collapses lanes, filters them, notes limits, and opens a checkpoint's diff", async () => {
  const registry = setup();
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <LoomHarness />
    </RegistryContext.Provider>,
    { router: "/loom/loom-browser/project" },
  );

  await expect.element(page.getByRole("button", { name: "Explore auth module" })).toBeVisible();
  await expect.element(page.getByRole("status")).toHaveTextContent("Limited: older runs.");
  expect(
    lanes()
      .elements()
      .map((element) => element.dataset.threadId),
  ).toEqual([rootId, childId, otherId]);

  await userEvent.click(page.getByRole("button", { name: "Collapse Fix login" }));
  await expect
    .element(page.getByRole("button", { name: "Explore auth module" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText("+1")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Expand Fix login" }));
  await expect.element(page.getByRole("button", { name: "Explore auth module" })).toBeVisible();

  await userEvent.fill(page.getByRole("textbox", { name: "Filter by title" }), "billing");
  await vi.waitFor(() => expect(lanes().elements()).toHaveLength(1));
  expect(lanes().elements()[0]?.dataset.threadId).toBe(otherId);
  await userEvent.click(page.getByRole("button", { name: "Clear" }));
  await vi.waitFor(() => expect(lanes().elements()).toHaveLength(3));

  await userEvent.click(
    lanes()
      .first()
      .getByRole("button", { name: /^Checkpoint: 2 files/ }),
  );
  await expect
    .element(page.getByRole("complementary").getByText("Fix login", { exact: true }))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Open diff" }));
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe(`/${environmentId}/${rootId}`),
  );
  expect(Object.values(useDiffPanelStore.getState().byThreadKey)).toContainEqual(
    expect.objectContaining({ kind: "turn", turnId: runId }),
  );
});
