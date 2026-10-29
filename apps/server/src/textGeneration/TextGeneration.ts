import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProviderInstanceId, TextGenerationOperation } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
  ConversationSummaryGenerationInput,
  ConversationSummaryGenerationResult,
  KnowledgeCandidatesGenerationInput,
  KnowledgeCandidatesGenerationResult,
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

const resolveInstance = Effect.fn("TextGeneration.resolveInstance")(function* (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOperation,
  instanceId: ProviderInstanceId,
): Effect.fn.Return<ProviderInstance["textGeneration"], TextGenerationError> {
  const instance = yield* registry.getInstance(instanceId);
  if (!instance) {
    return yield* new TextGenerationError({
      operation,
      detail: `No provider instance registered for id '${instanceId}'.`,
    });
  }
  if (!instance.textGeneration.supportedOperations.includes(operation)) {
    return yield* new TextGenerationError({
      operation,
      detail: `Provider '${instanceId}' does not support this text generation operation. Choose a model from a provider that supports it.`,
    });
  }
  return instance.textGeneration;
});

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  return TextGeneration.of({
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return resolveInstance(
        registry,
        "generateCommitMessage",
        input.modelSelection.instanceId,
      ).pipe(Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)));
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return resolveInstance(registry, "generateReviewGuide", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateReviewGuide(input)),
      );
    }),
    generateKnowledgeCandidates: Effect.fn("TextGeneration.generateKnowledgeCandidates")(
      function (input) {
        return resolveInstance(
          registry,
          "generateKnowledgeCandidates",
          input.modelSelection.instanceId,
        ).pipe(
          Effect.flatMap((textGeneration) => textGeneration.generateKnowledgeCandidates(input)),
        );
      },
    ),
    generateConversationSummary: Effect.fn("TextGeneration.generateConversationSummary")(
      function (input) {
        return resolveInstance(
          registry,
          "generateConversationSummary",
          input.modelSelection.instanceId,
        ).pipe(
          Effect.flatMap((textGeneration) => textGeneration.generateConversationSummary(input)),
        );
      },
    ),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({ ...input, linkedContext });
          }),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(TextGeneration, make);
