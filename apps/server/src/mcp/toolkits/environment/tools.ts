import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ConnectedEnvironmentsResult,
  CrossEnvironmentFailure,
  CrossEnvironmentLaunchRequest,
  CrossEnvironmentLaunchResult,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as CrossEnvironmentMcpService from "../../CrossEnvironmentMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and selected environment preferences. Provider/model availability is exposed by orchestrator_capabilities. Writing instructions are limited to 4,000 characters.",
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const crossEnvironmentFailure = Schema.Union([CrossEnvironmentFailure, OrchestratorMcpFailure]);
const ConnectedEnvironmentsTool = Tool.make("t3_connected_environments", {
  failure: crossEnvironmentFailure,
  failureMode: "return" as const,
  dependencies: [...shared.dependencies, CrossEnvironmentMcpService.CrossEnvironmentMcpService],
  description:
    "List this server and the peers this client is connected to, including host resources and whether each one has this thread's repository.",
  parameters: Schema.Struct({}),
  success: ConnectedEnvironmentsResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentLaunchTool = Tool.make("t3_environment_launch", {
  failure: crossEnvironmentFailure,
  failureMode: "return" as const,
  dependencies: [...shared.dependencies, CrossEnvironmentMcpService.CrossEnvironmentMcpService],
  description:
    "Start a thread on a connected peer that has this repository. The thread is independent of this one. Retry with the same clientRequestId and parameters: the source saves the chosen destination before dispatch and reuses it across reconnects and restarts. Reusing a clientRequestId with different parameters is rejected. An unconfirmed launch may already have started; inspect its threadId or retry the same request.",
  parameters: CrossEnvironmentLaunchRequest,
  success: CrossEnvironmentLaunchResult,
}).annotate(Tool.Destructive, true);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update selected environment-wide preferences through normal settings persistence and notifications. Requires a live full-access/default calling thread. Omitted fields are preserved; empty customInstructions clears them.",
  parameters: Schema.Struct({
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  ConnectedEnvironmentsTool,
  EnvironmentLaunchTool,
  EnvironmentPreferencesTool,
);
