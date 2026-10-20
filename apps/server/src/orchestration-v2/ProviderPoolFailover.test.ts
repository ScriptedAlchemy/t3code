import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";

import { limitCooldownUntilMs } from "./ProviderPoolFailover.ts";

const nowMs = Date.parse("2026-10-20T12:00:00.000Z");
const futureResetAt = "2026-10-20T12:10:00.000Z";
const pastResetAt = "2026-10-20T11:50:00.000Z";

const failure = (code: "rateLimitExceeded" | "usageLimitExceeded" | null, resetAt?: string) =>
  ({
    class: "usage_limit",
    message: "Provider limit reached",
    code,
    retryable: null,
    ...(resetAt === undefined ? {} : { resetAt }),
  }) satisfies OrchestrationV2ProviderFailure;

describe("limitCooldownUntilMs", () => {
  it.each(["rateLimitExceeded", "usageLimitExceeded"] as const)(
    "uses a future reset for %s",
    (code) => {
      assert.strictEqual(
        limitCooldownUntilMs(failure(code, futureResetAt), nowMs),
        Date.parse(futureResetAt),
      );
    },
  );

  it.each([pastResetAt, undefined])(
    "uses a one-minute cooldown for a rate-limit burst with reset %s",
    (resetAt) => {
      assert.strictEqual(
        limitCooldownUntilMs(failure("rateLimitExceeded", resetAt), nowMs),
        nowMs + 60_000,
      );
    },
  );

  it.each(["usageLimitExceeded", null] as const)(
    "uses the default cooldown for code %s without a future reset",
    (code) => {
      assert.strictEqual(limitCooldownUntilMs(failure(code), nowMs), nowMs + 15 * 60_000);
    },
  );
});
