import { useIsFocused } from "@react-navigation/native";
import { useEffect } from "react";
import {
  pullRequestChecksRefreshIntervalMs,
  resolvePullRequestDetailChecks,
} from "@t3tools/client-runtime/pull-request-checks";
import type { PullRequestDetail } from "@t3tools/contracts";
import { useAppActive } from "../../lib/appState";
import { useEnvironmentServerConfig } from "../../state/entities";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

/**
 * Re-reads only the checks while an open change request is on screen, so a running CI shows up
 * without paying for a full detail read every poll.
 */
export function usePullRequestLiveChecks(
  params: PullRequestParams,
  detail: PullRequestDetail | null,
): PullRequestDetail | null {
  const target = pullRequestTarget(params);
  const active = useAppActive();
  const focused = useIsFocused();
  const connected = usePullRequestConnected(target.environmentId);
  const supported =
    useEnvironmentServerConfig(target.environmentId)?.environment.capabilities.pullRequestChecks ===
    true;
  const checks = useEnvironmentQuery(
    active && focused && connected && supported && detail !== null
      ? composerPullRequests.checks(target)
      : null,
  );
  // Both reads carry the server's observedAt; without it the poll is the fresher stream.
  const live = resolvePullRequestDetailChecks(detail, checks.data, true);
  // A failed read keeps polling; only a host that answers "no checks" (null) stops it.
  const enabled =
    active &&
    focused &&
    connected &&
    supported &&
    !checks.isPending &&
    live?.state === "open" &&
    !(checks.isSuccess && checks.data === null);
  const intervalMs = pullRequestChecksRefreshIntervalMs(live?.checks ?? []);
  const { refresh } = checks;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls while the route is focused and the native app is active
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs, refresh]);
  return live;
}
