import "~/index.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  IssueTrackerKind,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

function pullRequest(
  number: number,
  title: string,
  state: ThreadPullRequestSnapshot["state"],
  isDraft = false,
): ThreadPullRequestLink {
  const repository = "demo/workspace";
  const date = `2026-01-${String(number).padStart(2, "0")}T00:00:00.000Z`;
  return {
    host: "github.com",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    source: "manual",
    linkedAt: date,
    stack: null,
    snapshot: {
      title,
      state,
      isDraft,
      headBranch: `feature-${number}`,
      baseBranch: "main",
      updatedAt: date,
      syncedAt: date,
    },
  };
}

it("searches linked issues and PRs, sorts PRs, and hides open PRs independently of drafts", async () => {
  const thread = {
    ...threadWithHistory("linked-items", 1),
    pullRequests: [
      pullRequest(2, "Add the import screen", "open"),
      pullRequest(12, "Revise the documentation", "open", true),
      pullRequest(14, "Publish the release", "merged"),
      pullRequest(16, "Tidy the old settings", "closed"),
    ],
    issues: [
      {
        tracker: IssueTrackerKind.make("github"),
        host: "github.com",
        scope: "demo/workspace",
        key: "42",
        displayKey: "#42",
        title: "Café setup",
        url: "https://github.com/demo/workspace/issues/42",
        projectId: PROJECT_ID,
        source: "manual" as const,
        linkedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  using _environment = installFakeEnvironment([thread]);
  using restoreSettings = new DisposableStack();
  const previous = getClientSettings();
  restoreSettings.defer(() => __setClientSettingsForTests(previous));
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1300, 780);
  const ref = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${ref.threadId}`] }),
  );
  await router.load();
  // AppRoot brings its own router.
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect
    .element(page.getByText("Thread linked-items", { exact: true }).first())
    .toBeVisible();
  await act(() => useRightPanelStore.getState().open(ref, "pull-requests"));
  const open = page.getByRole("link", { name: /Add the import screen/ });
  const draft = page.getByRole("link", { name: /Revise the documentation/ });
  const merged = page.getByRole("link", { name: /Publish the release/ });
  const closed = page.getByRole("link", { name: /Tidy the old settings/ });
  const issue = page
    .getByRole("region", { name: "Linked issues" })
    .getByRole("link", { name: /Café setup/ });
  await expect.element(closed).toBeVisible();

  const controls = page.getByRole("button", { name: "Sort and filter linked items" });
  await controls.click();
  await page.getByRole("menuitemradio", { name: "Title", exact: true }).click();
  await vi.waitFor(() => {
    expect(open.element().getBoundingClientRect().top).toBeLessThan(
      closed.element().getBoundingClientRect().top,
    );
  });

  await page.getByRole("menuitemcheckbox", { name: "Open", exact: true }).click();
  await userEvent.keyboard("{Escape}");
  await expect.element(open).not.toBeInTheDocument();
  await expect.element(draft).toBeVisible();
  await expect.element(merged).toBeVisible();

  const search = page.getByRole("searchbox", { name: "Search linked items" });
  await search.fill("cafe");
  await expect.element(issue).toBeVisible();
  await expect.element(merged).not.toBeInTheDocument();
  await search.fill("#2");
  await expect.element(draft).not.toBeInTheDocument();
  await expect.element(page.getByText("No matching linked items")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect.element(open).toBeVisible();
  await expect.element(draft).toBeVisible();
});
