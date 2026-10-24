import {
  CommandId,
  type ProjectId,
  type ProjectKnowledgeError,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { PendingOrchestrationEffectV2 } from "../../orchestration-v2/EffectOutbox.ts";

export function deliveryScrubEffect(input: {
  readonly projectId: ProjectId;
  readonly removalId: string;
  readonly afterId?: string | undefined;
}): PendingOrchestrationEffectV2 {
  const id = `effect:project-knowledge.scrub-deliveries:${input.projectId}:${input.removalId}${input.afterId === undefined ? "" : `:page:${input.afterId}`}`;
  return {
    id,
    commandId: CommandId.make(id),
    // Use a project-wide side lane without depending on a surviving thread.
    threadId: ThreadId.make(`project-knowledge:${input.projectId}`),
    request: {
      type: "project-knowledge.scrub-deliveries",
      projectId: input.projectId,
      removalId: input.removalId,
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
    },
  };
}

export interface DeliveryScrubRunnerShape {
  readonly scrubPage: (input: {
    readonly projectId: ProjectId;
    readonly afterId?: string | undefined;
  }) => Effect.Effect<string | null, ProjectKnowledgeError>;
}

export class DeliveryScrubRunner extends Context.Reference<DeliveryScrubRunnerShape>(
  "t3/project/knowledge/DeliveryScrubRunner",
  { defaultValue: () => ({ scrubPage: () => Effect.succeed(null) }) },
) {}
