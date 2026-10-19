import {
  findProviderPool,
  runPoolFailoverCommandId,
  type IsoDateTime,
  type OrchestrationV2ProviderFailure,
  type ProviderInstanceId,
  type RunAttemptId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { ProviderPoolCatalog } from "./ProviderPoolCatalog.ts";
import { earliestPoolResetAtMs, poolMemberHealth } from "./ProviderPoolRouting.ts";

export interface UsageLimitedAttempt {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly failure: OrchestrationV2ProviderFailure;
}

export type UsageLimitResolution =
  /** The orchestrator moved the run to another member; this attempt's finalization is skipped. */
  | { readonly type: "failed_over" }
  /** Fail the run as today. For a pooled run `resetAt` is the pool's earliest reset. */
  | { readonly type: "finalize"; readonly resetAt: IsoDateTime | null };

/** Applied when the provider reports a usage limit without a reset time. */
export const DEFAULT_LIMIT_COOLDOWN_MS = 15 * 60_000;

/**
 * Runs between a usage-limit terminal and the run going terminal. A reference
 * with a pass-through default, shaped like RunFinalizationObserver, so
 * RunExecutionService gains no layer dependency on the orchestrator.
 */
export class ProviderUsageLimitHook extends Context.Reference<{
  readonly onUsageLimit: (input: UsageLimitedAttempt) => Effect.Effect<UsageLimitResolution>;
}>("t3/orchestration-v2/ProviderUsageLimitHook", {
  defaultValue: () => ({
    onUsageLimit: (input) =>
      Effect.succeed({ type: "finalize", resetAt: input.failure.resetAt ?? null }),
  }),
}) {}

const make = Effect.gen(function* () {
  const catalog = yield* ProviderPoolCatalog;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const onUsageLimit = Effect.fn("ProviderPoolFailover.onUsageLimit")(function* (
    input: UsageLimitedAttempt,
  ) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const resetMs = input.failure.resetAt == null ? Number.NaN : Date.parse(input.failure.resetAt);
    // Every driver cools through this one site, pooled or not, so the
    // Providers page shows "Limited until" for any account.
    yield* catalog.markLimited({
      instanceId: input.providerInstanceId,
      until: DateTime.formatIso(
        DateTime.makeUnsafe(resetMs > nowMs ? resetMs : nowMs + DEFAULT_LIMIT_COOLDOWN_MS),
      ),
    });
    const asToday = { type: "finalize", resetAt: input.failure.resetAt ?? null } as const;
    if (findProviderPool(yield* catalog.getPublishedProviders, input.providerInstanceId) === null) {
      return asToday;
    }
    yield* orchestrator
      .dispatch({
        type: "run.pool-failover",
        commandId: runPoolFailoverCommandId(input.attemptId),
        threadId: input.threadId,
        runId: input.runId,
        attemptId: input.attemptId,
        failure: input.failure,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.pool-failover.dispatch-failed", {
            threadId: input.threadId,
            runId: input.runId,
            cause,
          }),
        ),
      );
    const records = yield* projections
      .getThreadRecords(input.threadId, ["runs"], { runIds: [input.runId] })
      .pipe(Effect.orElseSucceed(() => null));
    const run = records?.runs.find((candidate) => candidate.id === input.runId);
    if (run !== undefined && run.activeAttemptId !== input.attemptId) {
      return { type: "failed_over" } as const;
    }
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (records === null || settings === null) return asToday;
    const pool = findProviderPool(yield* catalog.getPublishedProviders, input.providerInstanceId);
    const earliest = earliestPoolResetAtMs(
      poolMemberHealth({
        members: pool?.members ?? [],
        settings,
        projectId: records.thread.projectId,
        nowMs,
      }),
      nowMs,
    );
    return earliest === null
      ? asToday
      : ({ type: "finalize", resetAt: DateTime.formatIso(DateTime.makeUnsafe(earliest)) } as const);
  });

  return { onUsageLimit };
});

export const layer = Layer.effect(ProviderUsageLimitHook, make);
