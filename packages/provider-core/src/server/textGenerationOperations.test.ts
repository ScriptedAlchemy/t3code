import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decodeJsonReply, fromRunner, type Operation } from "./textGenerationOperations.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("writer"), model: "chosen" };

it.effect("keeps structured intelligence available without allowing checkout investigation", () =>
  Effect.gen(function* () {
    const calls: Operation[] = [];
    const runtime = fromRunner(
      "Fixture",
      (request) => {
        calls.push(request.operation);
        return decodeJsonReply(
          request,
          "Fixture",
          '{"statements":[{"text":"Keep the API.","citations":["M1"]}]}',
        );
      },
      { supportsInvestigation: false },
    );
    expect(
      yield* runtime.generateConversationSummary({
        cwd: "/project",
        modelSelection,
        messages: [{ ref: "M1", role: "user", text: "Keep the API." }],
      }),
    ).toEqual({ statements: [{ text: "Keep the API.", citations: ["M1"] }] });
    const error = yield* runtime
      .generateReviewGuide({
        cwd: "/project",
        modelSelection,
        number: 1,
        title: "API",
        description: "",
        baseBranch: "main",
        baseCommit: "base",
        settledReview: "review",
      })
      .pipe(Effect.flip);
    expect(error.operation).toBe("generateReviewGuide");
    expect(calls).toEqual(["generateConversationSummary"]);
    expect(runtime.supportedOperations).toContain("generateConversationSummary");
    expect(runtime.supportedOperations).toContain("generateKnowledgeCandidates");
    expect(runtime.supportedOperations).not.toContain("generateReviewGuide");
  }),
);
