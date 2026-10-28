import {
  OrchestratorMcpFailure,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  isFastProviderOptionSelection,
  pinStandardProviderOptionSelections,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";

type Settings = Pick<ServerSettings, "agentFastModeEnabled">;

export function agentModelOptions(
  settings: Settings,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
  descriptors?: ReadonlyArray<ProviderOptionDescriptor>,
) {
  if (settings.agentFastModeEnabled) return options;
  const pinned = pinStandardProviderOptionSelections(options, descriptors);
  return options === undefined && pinned.length === 0 ? undefined : pinned;
}

export function agentModelSelection(
  settings: Settings,
  selection: ModelSelection,
  descriptors?: ReadonlyArray<ProviderOptionDescriptor>,
): ModelSelection {
  const options = agentModelOptions(settings, selection.options, descriptors);
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
