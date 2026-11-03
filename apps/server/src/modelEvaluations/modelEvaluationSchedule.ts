import {
  CommandId,
  type ModelEvaluationError,
  type ModelEvaluationGuidance,
  type ModelEvaluationRunOutcome,
  type ProjectId,
  type ProviderInstanceId,
  type RunId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PendingOrchestrationEffectV2 } from "../orchestration-v2/EffectOutbox.ts";

export function modelEvaluationEffects(input: {
  readonly settings: ServerSettings;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly runOutcome: ModelEvaluationRunOutcome;
}): ReadonlyArray<PendingOrchestrationEffectV2> {
  if (!input.settings.enableModelEvaluations) return [];
  return [
    {
      id: `effect:model-evaluation.generate:${input.runId}`,
      commandId: CommandId.make(`command:effect:model-evaluation.generate:${input.runId}`),
      threadId: input.threadId,
      request: {
        type: "model-evaluation.generate",
        runId: input.runId,
        runOutcome: input.runOutcome,
      },
    },
  ];
}

export class ModelEvaluationPassError extends Schema.TaggedError<ModelEvaluationPassError>()(
  "ModelEvaluationPassError",
  { runId: Schema.String, cause: Schema.Defect() },
) {}

interface Runtime {
  readonly enqueueRun: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly runOutcome: ModelEvaluationRunOutcome;
  }) => Effect.Effect<void, ModelEvaluationPassError>;
  readonly evaluateRun: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly runOutcome: ModelEvaluationRunOutcome;
  }) => Effect.Effect<void, ModelEvaluationPassError>;
  readonly guidance: (input: {
    readonly projectId: ProjectId;
    readonly models?: ReadonlyArray<{
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
    }>;
  }) => Effect.Effect<ReadonlyArray<ModelEvaluationGuidance>, ModelEvaluationError>;
}

export class ModelEvaluationRuntime extends Context.Reference<Runtime>(
  "t3/modelEvaluations/ModelEvaluationRuntime",
  {
    defaultValue: () => ({
      evaluateRun: () => Effect.void,
      enqueueRun: () => Effect.void,
      guidance: () => Effect.succeed([]),
    }),
  },
) {}
