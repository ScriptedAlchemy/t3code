import { useAtomValue } from "@effect/atom-react";
import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { providersIgnoringCheckedAtAtom, serverEnvironment } from "../../state/server";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { ProviderLimitedUntil } from "./ProviderLimitedUntil";
import {
  buildProviderPoolCards,
  buildProviderPoolPatch,
  modelCoverageLabel,
  type ProviderPoolChange,
} from "./ProviderPoolsSettings.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function ProviderPoolsSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const providerPools = useEnvironmentSettings(environmentId, (settings) => settings.providerPools);
  const supportsProviderPools = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.providerPools === true,
  );
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const cards = buildProviderPoolCards(providers, providerPools);
  const { id, title } = searchableSetting("account-pools");

  if (!supportsProviderPools) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          This environment's server is too old for account pools. Update it to use them.
        </p>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer className="gap-8">
      <SettingsSection id={id} title={title}>
        <SettingsRow
          title="Share the work across accounts"
          description="Pool two or more accounts of the same provider. The model picker then shows one entry for the provider, each turn runs on an account that still has quota, and a turn that hits a usage limit continues on another account. A conversation stays on its account while that account is available. Switching Claude accounts continues from a summary of the conversation; accounts that share one Codex home carry on natively."
        />
      </SettingsSection>
      {cards.length === 0 ? (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          Add a second account for a provider on the Providers page to pool them.
        </p>
      ) : (
        cards.map((card) => {
          const update = (change: ProviderPoolChange) =>
            updateSettings({
              providerPools: buildProviderPoolPatch(
                card.driver,
                providerPools[card.driver],
                change,
              ),
            });
          return (
            <SettingsSection key={card.driver} title={card.label}>
              <SettingsRow
                title="Pool these accounts"
                description={
                  card.canEnable
                    ? `One ${card.label} entry in the model picker, with turns routed across the ticked accounts.`
                    : "Tick at least two accounts to turn the pool on."
                }
                status={card.modelCoverage ? modelCoverageLabel(card.modelCoverage) : undefined}
                control={
                  <Switch
                    aria-label={`Pool ${card.label} accounts`}
                    checked={card.enabled}
                    disabled={!canManage || (!card.canEnable && !card.enabled)}
                    onCheckedChange={(enabled) => update({ type: "enabled", enabled })}
                  />
                }
              />
              {card.candidates.map((candidate) => (
                <SettingsRow
                  key={candidate.instanceId}
                  title={candidate.displayName}
                  description={
                    <>
                      <span className="block">
                        {candidate.status}
                        <ProviderLimitedUntil
                          provider={candidate.provider}
                          className="ms-1.5 text-warning-foreground"
                        />
                      </span>
                      {candidate.continuationHint ? (
                        <span className="block">{candidate.continuationHint}</span>
                      ) : null}
                      {candidate.sameLoginHint ? (
                        <span className="block text-muted-foreground">
                          {candidate.sameLoginHint}
                        </span>
                      ) : null}
                    </>
                  }
                  control={
                    <Checkbox
                      aria-label={`Include ${candidate.displayName} in the ${card.label} pool`}
                      checked={candidate.ticked}
                      disabled={!canManage}
                      onCheckedChange={(ticked) =>
                        update({ type: "tick", instanceId: candidate.instanceId, ticked })
                      }
                    />
                  }
                />
              ))}
            </SettingsSection>
          );
        })
      )}
    </SettingsPageContainer>
  );
}
