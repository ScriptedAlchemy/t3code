import {
  OrchestratorMcpFailure,
  type ModelSelection,
  type ProviderOptionSelection,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  isFastProviderOptionSelection,
  withoutFastProviderOptionSelections,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";

type Settings = Pick<ServerSettings, "agentFastModeEnabled">;

export function agentModelOptions(
  settings: Settings,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
) {
  return settings.agentFastModeEnabled || options === undefined
    ? options
    : withoutFastProviderOptionSelections(options);
}

export function agentModelSelection(settings: Settings, selection: ModelSelection): ModelSelection {
  const options = agentModelOptions(settings, selection.options);
  return { ...selection, ...(options === undefined ? {} : { options }) };
}

export const assertAgentModelOptions = Effect.fn("AgentFastMode.assertOptions")(function* (
  settings: Settings,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
) {
  if (!settings.agentFastModeEnabled && options?.some(isFastProviderOptionSelection)) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "fast mode is turned off for agents in Settings. Retry without fast mode options.",
    });
  }
});
