import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { ProjectLoomPage } from "../components/loom/ProjectLoomPage";
import { validateLoomSearch } from "../components/loom/loomSearch";

export const Route = createFileRoute("/loom/$environmentId/$projectId")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  validateSearch: validateLoomSearch,
  component: LoomRouteView,
});

function LoomRouteView() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectLoomPage
      environmentId={params.environmentId as EnvironmentId}
      projectId={params.projectId as ProjectId}
      search={search}
      onSearchChange={(update) => void navigate({ search: update, replace: true })}
    />
  );
}
