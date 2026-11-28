import type { ThreadIssueLink, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  pullRequestListLines,
  resolveThreadPullRequestChains,
} from "@t3tools/client-runtime/thread-pull-requests";
import { normalizeSearchText } from "~/lib/utils";

export type LinkedItemsSort = "default" | "title" | "repository";
export type LinkedPullRequestStatus = "draft" | "open" | "merged" | "closed";

function pullRequestStatus(link: ThreadPullRequestLink): LinkedPullRequestStatus | null {
  const snapshot = link.snapshot;
  if (snapshot === null) return null;
  return snapshot.state === "open" && snapshot.isDraft ? "draft" : snapshot.state;
}

export function linkedItemsView(
  pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  issues: ReadonlyArray<ThreadIssueLink>,
  options: {
    query: string;
    sort: LinkedItemsSort;
    hiddenStatuses: ReadonlySet<LinkedPullRequestStatus>;
  },
) {
  const query = normalizeSearchText(options.query);
  const number = /^#?(\d+)$/.exec(query)?.[1];
  const matches = (values: ReadonlyArray<string>) =>
    values.some((value) => normalizeSearchText(value).includes(query));

  const matchingLinks =
    query === "" && options.hiddenStatuses.size === 0
      ? pullRequests
      : pullRequests.filter((link) => {
          const status = pullRequestStatus(link);
          if (status !== null && options.hiddenStatuses.has(status)) return false;
          if (query === "") return true;
          if (number !== undefined) return String(link.number) === number;
          return matches([
            link.snapshot?.title ?? "",
            link.repository,
            link.url,
            `${link.repository}#${link.number}`,
          ]);
        });
  const matchingIssues =
    query === ""
      ? issues
      : issues.filter((issue) =>
          number !== undefined
            ? issue.key === number || issue.displayKey === `#${number}`
            : matches([issue.title, issue.displayKey, issue.scope, issue.url]),
        );
  const lines = pullRequestListLines(resolveThreadPullRequestChains(matchingLinks));
  if (options.sort === "default") return { lines, issues: matchingIssues };

  const sortedByTitle = options.sort === "title";
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const linkLabels = new Map(
    lines
      .filter((line) => line.depth === 0)
      .map(({ chainKey, link }) => [
        chainKey,
        sortedByTitle ? (link.snapshot?.title ?? link.repository) : link.repository,
      ]),
  );
  return {
    // Stable sorting moves a stack as a group while keeping its layers in their original order.
    lines: lines.toSorted((a, b) =>
      collator.compare(
        linkLabels.get(a.chainKey) ?? a.link.repository,
        linkLabels.get(b.chainKey) ?? b.link.repository,
      ),
    ),
    issues: matchingIssues.toSorted((a, b) =>
      collator.compare(sortedByTitle ? a.title : a.scope, sortedByTitle ? b.title : b.scope),
    ),
  };
}
