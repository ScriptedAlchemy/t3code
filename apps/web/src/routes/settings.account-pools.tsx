import { createFileRoute } from "@tanstack/react-router";

import { ProviderPoolsSettings } from "../components/settings/ProviderPoolsSettings";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

function SettingsAccountPoolsRoute() {
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up its account pools.`
          : "Connect an environment to set up its account pools."}
      </p>
    );
  }
  return <ProviderPoolsSettings environmentId={environment.environmentId} />;
}

export const Route = createFileRoute("/settings/account-pools")({
  component: SettingsAccountPoolsRoute,
});
