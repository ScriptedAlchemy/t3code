import { projectCodeIndexBadge } from "@t3tools/client-runtime/projectCode";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { Badge } from "~/components/ui/badge";
import { projectCode } from "~/state/projectCode";
import { useEnvironmentQuery } from "~/state/query";

const VARIANT = { ok: "success", warn: "warning", muted: "secondary" } as const;

/**
 * Plain-text freshness of a checkout's code index. It reads the index without building one,
 * and shows nothing until the server answers rather than guessing a state.
 */
export function CodeIndexBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const freshness = useEnvironmentQuery(
    projectCode.freshness({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        threadId: props.threadId,
        query: { operation: "freshness" },
      },
    }),
  );
  if (freshness.data === null && freshness.error === null) return null;
  const badge =
    freshness.data === null
      ? { label: "Unavailable", tone: "muted" as const, detail: freshness.error ?? "" }
      : projectCodeIndexBadge(freshness.data.index);
  return (
    <Badge
      variant={VARIANT[badge.tone]}
      size="sm"
      title={badge.detail}
      aria-label={`Code index: ${badge.label}. ${badge.detail}`}
    >
      {badge.label}
    </Badge>
  );
}
