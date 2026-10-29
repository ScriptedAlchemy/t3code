import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { fromRunner } from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const selected = ProviderInstanceId.make("selected");
const input = {
  cwd: "/project",
  messages: [{ ref: "M1", role: "user" as const, text: "Keep the existing API." }],
  modelSelection: { instanceId: selected, model: "chosen-model" },
};

const make = (textGeneration: ProviderInstance["textGeneration"]) => {
  const getInstance = vi.fn((instanceId: typeof selected) =>
    Effect.succeed(
      instanceId === selected
        ? ({
            instanceId,
            displayName: "Selected provider",
            textGeneration,
          } as ProviderInstance)
        : undefined,
    ),
  );
  return {
    getInstance,
    service: TextGeneration.make.pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({ getInstance }),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => undefined,
          }),
        ),
      ),
    ),
  };
};

it.effect("rejects an unsupported selected operation before invoking a provider", () =>
  Effect.gen(function* () {
    const generateConversationSummary = vi.fn(() => Effect.succeed({ statements: [] }));
    const test = make({
      ...fromRunner("Fixture", () => Effect.die("Unexpected generation operation")),
      supportedOperations: ["generateThreadTitle"],
      generateConversationSummary,
    });
    const service = yield* test.service;
    const failure = yield* service.generateConversationSummary(input).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(TextGenerationError);
    expect(failure.operation).toBe("generateConversationSummary");
    expect(failure.detail).toContain("does not support");
    expect(generateConversationSummary).not.toHaveBeenCalled();
    expect(test.getInstance.mock.calls).toEqual([[selected]]);
  }),
);

it.effect("uses the exact selected instance and model for a supported operation", () =>
  Effect.gen(function* () {
    const result = { statements: [{ text: "Keep the existing API.", citations: ["M1"] }] };
    const generateConversationSummary = vi.fn(() => Effect.succeed(result));
    const test = make({
      ...fromRunner("Fixture", () => Effect.die("Unexpected generation operation")),
      supportedOperations: ["generateConversationSummary"],
      generateConversationSummary,
    });
    const service = yield* test.service;
    expect(yield* service.generateConversationSummary(input)).toEqual(result);
    expect(generateConversationSummary).toHaveBeenCalledExactlyOnceWith(input);
    expect(test.getInstance.mock.calls).toEqual([[selected]]);
  }),
);
