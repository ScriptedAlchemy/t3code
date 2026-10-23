import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectId,
  type ProjectKnowledgeStatus,
} from "@t3tools/contracts";
import { assistedLearningRunLabel } from "@t3tools/client-runtime/projectKnowledge";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

/** The project's opt-in for model-suggested facts and what the last run did with it. */
export function AssistedLearningSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly status: ProjectKnowledgeStatus | null;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = config?.settings;
  if (!settings || config.environment.capabilities.projectSettingsOverrides !== true) return null;
  const enabled = resolveProjectSettings(settings, props.projectId).settings.enableAssistedLearning;
  const lastRun = props.status?.assistedLearning?.lastRun ?? null;
  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId: props.environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [props.projectId]: {
              ...settings.projectSettingsOverrides[props.projectId],
              enableAssistedLearning: next,
            },
          },
        },
      },
    });
    setBusy(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <section aria-label="Assisted learning" className="flex flex-col gap-1 rounded-md border p-3">
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!canWrite || busy}
          onChange={(event) => void toggle(event.target.checked)}
        />{" "}
        Suggest facts from finished runs
      </label>
      <p className="text-xs text-muted-foreground">
        After each run in this project, your text generation model reads that run and proposes up to
        three cited facts for you to review. Each run costs one model call.
      </p>
      {lastRun ? <p className="text-xs">{assistedLearningRunLabel(lastRun)}</p> : null}
      {!canWrite ? (
        <p className="text-xs">This connection cannot change project settings.</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
