import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  SourceControlProviderKind as SourceControlProviderKindSchema,
  type SourceControlProviderKind,
} from "@t3tools/contracts";

const FALLBACK_COOLDOWN = Duration.seconds(30);
const MAX_FALLBACK_COOLDOWN = Duration.minutes(15);

export const SourceControlPauseReason = Schema.Literals([
  "reserve-protected",
  "quota-exhausted",
  "rate-limited",
]);

export const CredentialScope = Context.Reference<string>(
  "@t3tools/source-control-core/server/SourceControlRateLimit/CredentialScope",
  {
    defaultValue: () => "",
  },
);

/** Interactive requests may use reserved quota; providers still enforce server cooldowns. */
export const Interactive = Context.Reference<boolean>(
  "@t3tools/source-control-core/server/SourceControlRateLimit/Interactive",
  { defaultValue: () => false },
);

interface RateLimitKey {
  readonly provider: SourceControlProviderKind;
  readonly host: string;
  readonly resource?: string | undefined;
}

interface RateLimitLease extends RateLimitKey {
  readonly lease: number;
}

interface RateLimitEntry {
  readonly attempt: number;
  readonly generation: number;
  readonly retryAt: number;
}

export class SourceControlRateLimitPausedError extends Schema.TaggedError<SourceControlRateLimitPausedError>()(
  "SourceControlRateLimitPausedError",
  {
    provider: SourceControlProviderKindSchema,
    host: Schema.String,
    retryAt: Schema.Number,
    pauseReason: Schema.optional(SourceControlPauseReason),
    resource: Schema.optional(Schema.String),
    remaining: Schema.optional(Schema.Finite),
    limit: Schema.optional(Schema.Finite),
  },
) {
  get detail(): string {
    if (this.pauseReason === "reserve-protected") {
      return `T3 paused background ${this.resource ?? "API"} reads to ${this.host} to protect the remaining quota${this.remaining === undefined ? "" : ` (${this.remaining}${this.limit === undefined ? "" : ` of ${this.limit}`} remaining)`}. Interactive actions can use the reserve.`;
    }
    if (this.pauseReason === "quota-exhausted") {
      return `${this.provider} ${this.resource ?? "API"} quota for ${this.host} is exhausted. Requests resume when that quota resets.`;
    }
    return `${this.provider} requests to ${this.host} are paused until the rate limit resets.`;
  }

  override get message(): string {
    return this.detail;
  }
}

export class SourceControlRateLimit extends Context.Service<
  SourceControlRateLimit,
  {
    readonly check: (
      key: RateLimitKey,
      options?: { readonly allowPaused: boolean },
    ) => Effect.Effect<number, SourceControlRateLimitPausedError>;
    readonly recordRateLimit: (
      input: RateLimitLease & {
        readonly retryAt?: number | undefined;
        readonly minimumCooldownMs?: number | undefined;
      },
    ) => Effect.Effect<void>;
    readonly recordSuccess: (input: RateLimitLease) => Effect.Effect<void>;
  }
>()("@t3tools/source-control-core/server/SourceControlRateLimit") {}

function normalizedKey(key: RateLimitKey, scope: string): string {
  return `${key.provider}\0${key.host.trim().toLowerCase()}\0${scope}\0${key.resource ?? ""}`;
}

function fallbackCooldownMs(
  attempt: number,
  minimum = Duration.toMillis(FALLBACK_COOLDOWN),
): number {
  return Math.min(
    Math.max(Duration.toMillis(FALLBACK_COOLDOWN), minimum) * 2 ** Math.max(0, attempt - 1),
    Duration.toMillis(MAX_FALLBACK_COOLDOWN),
  );
}

export function retryAtFromHeader(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (/^\d+$/u.test(normalized)) {
    const seconds = Number(normalized);
    const retryAt = now + seconds * 1_000;
    return Number.isSafeInteger(retryAt) ? retryAt : undefined;
  }
  const retryAt = Date.parse(normalized);
  return Number.isFinite(retryAt) && retryAt > now ? retryAt : undefined;
}

/** @public */
export const make = Effect.gen(function* () {
  const entries = yield* Ref.make<ReadonlyMap<string, RateLimitEntry>>(new Map());

  const check: SourceControlRateLimit["Service"]["check"] = Effect.fn(
    "SourceControlRateLimit.check",
  )(function* (input, options) {
    const now = yield* Clock.currentTimeMillis;
    const key = normalizedKey(input, yield* CredentialScope);
    const entry = (yield* Ref.get(entries)).get(key);
    if (entry !== undefined && entry.retryAt > now && options?.allowPaused !== true) {
      return yield* new SourceControlRateLimitPausedError({
        provider: input.provider,
        host: input.host.trim().toLowerCase(),
        retryAt: entry.retryAt,
        pauseReason: input.resource === undefined ? "rate-limited" : "quota-exhausted",
        ...(input.resource === undefined ? {} : { resource: input.resource }),
      });
    }
    return entry?.generation ?? 0;
  });

  const recordRateLimit: SourceControlRateLimit["Service"]["recordRateLimit"] = Effect.fn(
    "SourceControlRateLimit.recordRateLimit",
  )(function* (input) {
    const now = yield* Clock.currentTimeMillis;
    const key = normalizedKey(input, yield* CredentialScope);
    yield* Ref.update(entries, (current) => {
      const previous = current.get(key);
      if (previous !== undefined && previous.generation > input.lease) {
        if (previous.retryAt <= now && (input.retryAt === undefined || input.retryAt <= now)) {
          return current;
        }
        const retryAt =
          input.retryAt !== undefined && input.retryAt > previous.retryAt
            ? input.retryAt
            : previous.retryAt;
        if (retryAt === previous.retryAt) return current;
        const next = new Map(current);
        next.set(key, { ...previous, retryAt });
        return next;
      }

      const attempt = (previous?.attempt ?? 0) + 1;
      const proposedRetryAt =
        input.retryAt !== undefined && input.retryAt > now
          ? input.retryAt
          : now + fallbackCooldownMs(attempt, input.minimumCooldownMs);
      const retryAt =
        previous !== undefined && previous.retryAt > now
          ? Math.max(previous.retryAt, proposedRetryAt)
          : proposedRetryAt;
      const next = new Map(current);
      next.set(key, {
        attempt,
        generation: Math.max(previous?.generation ?? 0, input.lease) + 1,
        retryAt,
      });
      return next;
    });
  });

  const recordSuccess: SourceControlRateLimit["Service"]["recordSuccess"] = Effect.fn(
    "SourceControlRateLimit.recordSuccess",
  )(function* (input) {
    const now = yield* Clock.currentTimeMillis;
    const key = normalizedKey(input, yield* CredentialScope);
    yield* Ref.update(entries, (current) => {
      const previous = current.get(key);
      if (previous === undefined || previous.generation !== input.lease || previous.retryAt > now) {
        return current;
      }
      const next = new Map(current);
      next.set(key, { attempt: 0, generation: previous.generation, retryAt: 0 });
      return next;
    });
  });

  return SourceControlRateLimit.of({ check, recordRateLimit, recordSuccess });
});

export const layer = Layer.effect(SourceControlRateLimit, make);
