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
  activity: [],
  truncated: {
    lanes: false,
    ancestors: false,
    runs: true,
    markers: false,
    edges: false,
    activity: false,
    bytes: false,
  },
  coverage: {
    untimedTasks: 0,
    untimedTasksTruncated: false,
    commandsScanned: 0,
    commandsTruncated: false,
  },
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

function LoomHarness(props: { readonly initialSearch?: LoomSearch }) {
  const [search, setSearch] = useState<LoomSearch>(props.initialSearch ?? { from, to });
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
      <LoomHarness initialSearch={{ from, to, mode: "lanes" }} />
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

async function renderLoom(registry: AtomRegistry.AtomRegistry, initialSearch?: LoomSearch) {
  return render(
    <RegistryContext.Provider value={registry}>
      <LoomHarness {...(initialSearch === undefined ? {} : { initialSearch })} />
    </RegistryContext.Provider>,
    { router: "/loom/loom-browser/project" },
  );
}

it("pages older lanes of the default window within the bounds that produced the cursor", async () => {
  const registry = setup();
  const requests: Array<LoomWindowInput> = [];
  state.respond = (input) => {
    requests.push(input as LoomWindowInput);
    const firstPage = (input as LoomWindowInput).cursor === undefined;
    return Atom.make(
      AsyncResult.success({ ...fullWindow, nextCursor: firstPage ? "page-2" : null }),
    );
  };
  await using _screen = await renderLoom(registry, {});

  await userEvent.click(page.getByRole("button", { name: "Older lanes" }));
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0]).toEqual({ projectId });
  expect(requests[1]).toEqual({ projectId, from, to, cursor: "page-2" });
});

it("notes skipped command scans and untimed tasks", async () => {
  const registry = setup();
  state.respond = () =>
    Atom.make(
      AsyncResult.success({
        ...fullWindow,
        truncated: { ...fullWindow.truncated, runs: false },
        coverage: {
          untimedTasks: 3,
          untimedTasksTruncated: false,
          commandsScanned: 4000,
          commandsTruncated: true,
        },
      }),
    );
  await using _screen = await renderLoom(registry);

  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent(
      "Limited: test commands from the newest 4000 commands only, 3 agent tasks with no recorded time, not shown.",
    );
});

it("draws queue time only when the run's start is recorded or it has not started", async () => {
  const registry = setup();
  const unstarted = (status: "completed" | "queued", ordinal: number) => ({
    ...fullWindow.runs[0]!,
    id: RunId.make(`run-${status}`),
    ordinal,
    status,
    startedAt: null,
    completedAt: status === "completed" ? "2026-10-21T12:00:00.000Z" : null,
  });
  state.respond = () =>
    Atom.make(
      AsyncResult.success({
        ...fullWindow,
        runs: [unstarted("completed", 2), unstarted("queued", 3)],
      }),
    );
  await using _screen = await renderLoom(registry, { from, to, mode: "lanes" });

  const queueLine = (name: RegExp) =>
    page.getByRole("button", { name }).first().element().querySelector("line[stroke-dasharray]");
  await expect.element(page.getByRole("button", { name: /^Run 2, completed/ })).toBeVisible();
  expect(queueLine(/^Run 2, completed/)).toBeNull();
  expect(
    page
      .getByRole("button", { name: /^Run 2, completed/ })
      .element()
      .querySelector('line[data-timing="unknown"]'),
  ).not.toBeNull();
  expect(queueLine(/^Run 3, queued/)).not.toBeNull();
});

it("opens a workstream from the navigator in Agent mode and comes back to the overview", async () => {
  const registry = setup();
  // Spawned after the root's run, so the fitted view frames the spawn apart from the checkpoint.
  const spawnedLater = {
    ...fullWindow,
    lanes: fullWindow.lanes.map((entry) =>
      entry.threadId === childId ? { ...entry, createdAt: "2026-10-21T12:00:00.000Z" } : entry,
    ),
  };
  state.respond = () => Atom.make(AsyncResult.success(spawnedLater));
  await using _screen = await renderLoom(registry);

  await expect
    .element(page.getByRole("button", { name: "Workstream" }))
    .toHaveAttribute("aria-pressed", "true");
  const navigator = page.getByRole("complementary", { name: "Loom navigator" });
  await expect
    .element(navigator.getByRole("textbox", { name: "Search workstreams" }))
    .toBeVisible();
  await userEvent.click(navigator.getByRole("button", { name: /^Fix login/ }));

  await expect
    .element(page.getByRole("button", { name: "Agent" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(page.getByTestId("loom-weave")).toHaveAttribute("data-mode", "agent");
  await expect
    .element(navigator.getByRole("button", { name: /^Fix login/ }))
    .toHaveAttribute("aria-current", "true");
  await expect
    .element(page.getByRole("button", { name: /^Spawn, .*Explore auth module$/ }))
    .toBeVisible();

  await userEvent.click(page.getByRole("button", { name: /^Checkpoint, .*2 files/ }));
  const events = page.getByRole("complementary", { name: "Loom events" });
  await expect.element(events.getByText("Fix login", { exact: true })).toBeVisible();
  await expect.element(events.getByRole("button", { name: "Open diff" })).toBeVisible();
  await userEvent.click(events.getByRole("button", { name: "Back to navigator" }));
  await expect
    .element(navigator.getByRole("textbox", { name: "Search workstreams" }))
    .toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Overview" }));
  await expect.element(page.getByTestId("loom-weave")).toHaveAttribute("data-mode", "workstream");

  await userEvent.click(page.getByRole("button", { name: "Lanes" }));
  await expect.element(page.getByRole("button", { name: "Explore auth module" })).toBeVisible();
  expect(page.getByTestId("loom-lane").elements()).toHaveLength(3);
});
