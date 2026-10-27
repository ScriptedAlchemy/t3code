import { expect, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as ProjectKnowledge from "./ProjectKnowledge.ts";
import { readKnowledgeDeliveryState } from "./delivery.ts";

it.effect(
  "uses the status boundary for both delivery scopes without reading inspector evidence",
  () =>
    Effect.gen(function* () {
      const target = {
        projectId: ProjectId.make("project"),
        threadId: ThreadId.make("thread"),
        messageId: MessageId.make("message"),
        attemptId: RunAttemptId.make("attempt"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerThreadId: ProviderThreadId.make("provider-thread"),
        nativeThreadId: "original-native",
      };
      const state = { sent: false, sentThisAttempt: false, uncertain: true };
      const readDeliveryState = vi.fn<
        ProjectKnowledge.ProjectKnowledge["Service"]["readDeliveryState"]
      >(() => Effect.succeed(state));
      yield* Effect.gen(function* () {
        expect(yield* readKnowledgeDeliveryState(target)).toEqual(state);
        expect(yield* readKnowledgeDeliveryState(target, "attempt")).toEqual(state);
      }).pipe(
        Effect.provide(
          Layer.mock(ProjectKnowledge.ProjectKnowledge)({
            readDeliveryState,
            readDeliveries: () => Effect.die("Inspector evidence is not part of dispatch safety"),
          }),
        ),
      );
      expect(readDeliveryState.mock.calls).toEqual([
        [{ ...target, scope: "native-conversation" }],
        [{ ...target, scope: "attempt" }],
      ]);
    }),
);
