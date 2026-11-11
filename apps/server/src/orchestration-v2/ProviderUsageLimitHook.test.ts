import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ProviderFailure,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderUsageLimitHook from "./ProviderUsageLimitHook.ts";

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
        ProviderUsageLimitHook.limitCooldownUntilMs(failure(code, futureResetAt), nowMs),
        Date.parse(futureResetAt),
      );
    },
  );

  it.each([pastResetAt, undefined])(
    "uses a one-minute cooldown for a rate-limit burst with reset %s",
    (resetAt) => {
      assert.strictEqual(
        ProviderUsageLimitHook.limitCooldownUntilMs(failure("rateLimitExceeded", resetAt), nowMs),
        nowMs + 60_000,
      );
    },
  );

  it.each(["rateLimitExceeded", "usageLimitExceeded"] as const)(
    "ignores one account's reset for %s on a pooled route",
    (code) => {
      assert.strictEqual(
        ProviderUsageLimitHook.limitCooldownUntilMs(failure(code, futureResetAt), nowMs, true),
        nowMs + 60_000,
      );
    },
  );

  it.each(["usageLimitExceeded", null] as const)(
    "uses the default cooldown for code %s without a future reset",
    (code) => {
      assert.strictEqual(
        ProviderUsageLimitHook.limitCooldownUntilMs(failure(code), nowMs),
        nowMs + 15 * 60_000,
      );
    },
  );
});

it.effect.each([
  ["Codex proxy", "codex", { inferenceEnabled: true }, "gpt-5", 60_000],
  ["Claude proxy", "claudeAgent", { inferenceEnabled: true }, "claude-sonnet-4-6", 60_000],
  ["saved concrete route", "codex", { setupMode: "inference" }, "gpt-5", 60_000],
  ["native", "codex", { setupMode: "cli", inferenceEnabled: false }, "gpt-5", 10 * 60_000],
  ["native Pi model", "pi", { inferenceEnabled: true }, "openai/gpt-5", 10 * 60_000],
  ["default Pi model", "pi", { inferenceEnabled: true }, "default", 10 * 60_000],
  ["proxy Pi model", "pi", { inferenceEnabled: true }, "t3proxy/openai/gpt-5", 60_000],
  ["native OpenCode model", "opencode", { inferenceEnabled: true }, "openai/gpt-5", 10 * 60_000],
  ["proxy OpenCode model", "opencode", { inferenceEnabled: true }, "t3proxy/openai/gpt-5", 60_000],
  ["disabled Pi proxy", "pi", { inferenceEnabled: false }, "t3proxy/openai/gpt-5", 10 * 60_000],
] as const)("records the account cooldown for %s", ([, kind, config, model, cooldown]) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    const instanceId = ProviderInstanceId.make(kind);
    const limitedUntil = yield* Ref.make<string | undefined>(undefined);
    yield* Effect.gen(function* () {
      const hook = yield* ProviderUsageLimitHook.ProviderUsageLimitHook;
      yield* hook.onUsageLimit(instanceId, failure("usageLimitExceeded", futureResetAt), model);
    }).pipe(
      Effect.provide(
        ProviderUsageLimitHook.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              providerInstances: {
                [instanceId]: { driver: ProviderDriverKind.make(kind), config },
              },
            }),
          ),
          Layer.provide(
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              markLimited: ({ until }) => Ref.set(limitedUntil, until),
            }),
          ),
        ),
      ),
    );
    assert.equal(
      yield* Ref.get(limitedUntil),
      DateTime.formatIso(DateTime.makeUnsafe(nowMs + cooldown)),
    );
  }),
);
