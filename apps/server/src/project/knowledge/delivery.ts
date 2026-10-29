import {
  ProjectKnowledgeError,
  type ComposerContextRecord,
  type ProjectKnowledgeDelivery,
  type ProjectKnowledgeDeliveryStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProjectKnowledge from "./ProjectKnowledge.ts";
import { resolveKnowledgeComposer } from "./composer.ts";

type DeliveryTarget = Pick<
  ProjectKnowledgeDelivery,
  | "attemptId"
  | "runId"
  | "threadId"
  | "messageId"
  | "projectId"
  | "providerInstanceId"
  | "providerThreadId"
  | "nativeThreadId"
>;

export const readKnowledgeDeliveryState = Effect.fn("ProjectKnowledge.readDeliveryState")(
  function* (
    target: Omit<DeliveryTarget, "runId">,
    scope: "native-conversation" | "attempt" = "native-conversation",
  ) {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    return yield* knowledge.readDeliveryState({ ...target, scope });
  },
);

export const prepareKnowledgeDelivery = Effect.fn("ProjectKnowledge.prepareDelivery")(
  function* (input: {
    readonly target: DeliveryTarget;
    readonly text: string;
    readonly records: ReadonlyArray<ComposerContextRecord>;
  }) {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    let budget: ProjectKnowledgeDelivery["budget"];
    const refuse = Effect.fn("ProjectKnowledge.refuseDelivery")(function* (
      error: ProjectKnowledgeError,
    ) {
      const reason =
        error.reason === "context_budget"
          ? ("over_budget" as const)
          : error.reason === "stale_context"
            ? ("stale_revision" as const)
            : error.reason === "wrong_project" || error.reason === "wrong_environment"
              ? ("not_permitted" as const)
              : error.reason === "storage" || error.reason === "scoring"
                ? ("recall_failed" as const)
                : ("source_unavailable" as const);
      const omissions = input.records.flatMap((record) =>
        record.kind === "project-knowledge"
          ? [{ contextId: record.contextId, label: record.label, reason }]
          : [],
      );
      if (omissions.length === 0) return;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* knowledge.recordDelivery({
        ...input.target,
        status: "failed",
        items: [],
        omissions,
        ...(budget === undefined ? {} : { budget }),
        createdAt: now,
        updatedAt: now,
      });
    });
    const resolve = resolveKnowledgeComposer({
      projectId: input.target.projectId,
      text: input.text,
      records: input.records,
    }).pipe(
      Effect.provideService(ProjectKnowledge.ProjectKnowledge, knowledge),
      Effect.tapError(refuse),
    );
    const composer = yield* resolve;
    const readState = Effect.suspend(() =>
      composer.items.length > 0 || composer.omissions.length > 0
        ? readKnowledgeDeliveryState(input.target).pipe(
            Effect.provideService(ProjectKnowledge.ProjectKnowledge, knowledge),
          )
        : Effect.succeed({ sent: false, sentThisAttempt: false, uncertain: false }),
    );
    const record = Effect.fn("ProjectKnowledge.recordMessageDelivery")(function* (
      status: ProjectKnowledgeDeliveryStatus,
    ) {
      if (composer.items.length === 0 && composer.omissions.length === 0) return;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* knowledge.recordDelivery({
        ...input.target,
        status,
        items: composer.items,
        omissions: composer.omissions,
        ...(budget === undefined ? {} : { budget }),
        createdAt: now,
        updatedAt: now,
      });
    });
    const settle = (status: ProjectKnowledgeDeliveryStatus) =>
      record(status).pipe(
        Effect.catchCause(() =>
          Effect.logWarning("Failed to record project knowledge delivery status", {
            runId: input.target.runId,
            messageId: input.target.messageId,
            deliveryStatus: status,
          }),
        ),
      );
    const checkBudget = Effect.fn("ProjectKnowledge.checkDeliveryBudget")(function* (
      allowance: NonNullable<ProjectKnowledgeDelivery["budget"]>,
    ) {
      budget = allowance;
      if (composer.byteLength <= allowance.knowledgeAllowance) return;
      const error = new ProjectKnowledgeError({
        reason: "context_budget",
        projectId: input.target.projectId,
        byteLength: composer.byteLength,
      });
      yield* refuse(error);
      return yield* error;
    });
    return {
      composer,
      readState,
      record,
      settle,
      checkBudget,
      // Revalidate immediately before transport dispatch after any asynchronous handoff work.
      revalidate: composer.byteLength > 0 ? Effect.asVoid(resolve) : Effect.void,
    };
  },
);
