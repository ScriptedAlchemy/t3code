import type { OrchestrationV2ProviderFailure, ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

const DEFAULT_LIMIT_COOLDOWN_MS = 15 * 60_000;
// Per-minute burst limits recover quickly and should not park a healthy account.
const BURST_LIMIT_COOLDOWN_MS = 60_000;

export function limitCooldownUntilMs(
  failure: OrchestrationV2ProviderFailure,
  nowMs: number,
): number {
  const resetMs = failure.resetAt == null ? Number.NaN : Date.parse(failure.resetAt);
  if (resetMs > nowMs) return resetMs;
  return (
    nowMs +
    (failure.code === "rateLimitExceeded" ? BURST_LIMIT_COOLDOWN_MS : DEFAULT_LIMIT_COOLDOWN_MS)
  );
}

export class ProviderUsageLimitHook extends Context.Reference<{
  readonly onUsageLimit: (
    instanceId: ProviderInstanceId,
    failure: OrchestrationV2ProviderFailure,
  ) => Effect.Effect<void>;
}>("t3/orchestration-v2/ProviderUsageLimitHook", {
  defaultValue: () => ({ onUsageLimit: () => Effect.void }),
}) {}

export const layer = Layer.effect(
  ProviderUsageLimitHook,
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const onUsageLimit = Effect.fn("ProviderUsageLimitHook.onUsageLimit")(function* (
      instanceId: ProviderInstanceId,
      failure: OrchestrationV2ProviderFailure,
    ) {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      yield* registry.markLimited({
        instanceId,
        until: DateTime.formatIso(DateTime.makeUnsafe(limitCooldownUntilMs(failure, nowMs))),
      });
    });
    return { onUsageLimit };
  }),
);
