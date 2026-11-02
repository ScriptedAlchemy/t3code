import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import type { SettingsTarget } from "./settings-environment-filter";

export function SkillsLibrarySettings({ environment }: { readonly environment: SettingsTarget }) {
  return environment.serverConfig.environment.capabilities.skillsLibrary === true ? (
    <LibraryControls environment={environment} />
  ) : null;
}

function LibraryControls({ environment }: { readonly environment: SettingsTarget }) {
  const environmentId = environment.environmentId;
  const enabled = environment.serverConfig.settings.skillsLibraryEnabled;
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const canRefresh = useAtomValue(
    serverEnvironment.refreshSkillsLibrary.permissionAtom(environmentId),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const refreshLibrary = useAtomCommand(serverEnvironment.refreshSkillsLibrary, {
    reportFailure: false,
  });
  const status = useEnvironmentQuery(
    serverEnvironment.skillsLibraryStatus({ environmentId, input: {} }),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Success") return false;
    if (!isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    return true;
  };
  const refresh = (next?: boolean) => {
    if (pending || !canRefresh || (next !== undefined && !canWrite)) return;
    setPending(true);
    setError(null);
    const reconcile = async () => {
      if (
        next !== undefined &&
        failed(
          await updateSettings({ environmentId, input: { patch: { skillsLibraryEnabled: next } } }),
        )
      )
        return;
      const result = await refreshLibrary({ environmentId, input: {} });
      if (!failed(result)) status.refresh();
    };
    return reconcile()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setPending(false));
  };
  const failure = error ?? status.error;
  const needsRefresh = enabled || failure !== null || (status.data?.linked.length ?? 0) > 0;
  return (
    <>
      <SettingsSwitchRow
        icon="square.grid.2x2"
        label="Skills library"
        subtitle="Share skills across providers and accounts on this environment. Turning it off restores separate skill folders."
        value={enabled}
        disabled={pending || !canWrite || !canRefresh}
        onValueChange={(next) => void refresh(next)}
      />
      {needsRefresh && canRefresh ? (
        <ListActionRow
          icon="arrow.clockwise"
          label="Refresh skills library"
          description="After resolving a conflict or adding a skill, refresh to update the shared folders."
          loading={pending}
          onPress={() => void refresh()}
        />
      ) : null}
      {failure ? (
        <Text accessibilityRole="alert" className="px-4 pb-3 text-sm text-danger-foreground">
          {failure}
        </Text>
      ) : null}
      {status.data?.conflicts.map((conflict) => (
        <View key={conflict.name} className="gap-1 px-4 pb-3">
          <Text className="text-sm font-t3-medium">{conflict.name}</Text>
          <Text selectable className="text-sm text-foreground-muted">
            {conflict.reason === "outsideLink"
              ? `${conflict.paths[0]} has a link outside the skill at ${conflict.paths[1]}. Replace the link with the file before refreshing.`
              : `${conflict.paths[0]} and ${conflict.paths[1]} differ. Keep one copy before refreshing.`}
          </Text>
        </View>
      ))}
      {status.data?.nameMismatches.map((mismatch) => (
        <Text key={mismatch.name} selectable className="px-4 pb-3 text-sm text-foreground-muted">
          {mismatch.name} is named "{mismatch.frontmatterName}" in its SKILL.md. Some providers use
          the folder name and others use that name.
        </Text>
      ))}
    </>
  );
}
