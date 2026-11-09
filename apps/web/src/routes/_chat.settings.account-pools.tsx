import { createFileRoute } from "@tanstack/react-router";

import { InferenceSettings } from "../components/settings/InferenceSettings";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

function SettingsAccountPoolsRoute() {
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to manage inference accounts.`
          : "Connect an environment to manage inference accounts."}
      </p>
    );
  }
  if (environment.serverConfig?.environment.capabilities.inferenceProxy)
    return (
      <InferenceSettings
        key={environment.environmentId}
        environmentId={environment.environmentId}
      />
    );
  return (
    <p className="p-8 text-sm text-muted-foreground">
      Update T3 Code on {environment.label} to manage inference accounts.
    </p>
  );
}

export const Route = createFileRoute("/_chat/settings/account-pools")({
  component: SettingsAccountPoolsRoute,
});
