import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import { PinnedGitHubCredential } from "./GitHubRequestPolicy.ts";
import { makeChecksRevalidator } from "./gitHubConditionalChecks.ts";

it.effect("keeps the checks head through conditional 304 revalidation and head changes", () => {
  let head = "a".repeat(40);
  let reads = 0;
  const validators = new Map<string, string>();
  const layer = Layer.mock(GitHubRest.GitHubRest)({
    rest: (input) =>
      Effect.sync(() => {
        const etag = `${input.path}:${head}`;
        const unchanged = validators.get(input.path) === etag && input.ifNoneMatch === etag;
        validators.set(input.path, etag);
        return {
          status: unchanged ? 304 : 200,
          headers: { etag },
          body: input.path.endsWith("/pulls/1")
            ? JSON.stringify({ head: { sha: head, repo: { id: 1 } }, base: { repo: { id: 1 } } })
            : "{}",
          truncated: false,
          invalidUtf8: false,
        };
      }),
  });
  return Effect.gen(function* () {
    const read = yield* makeChecksRevalidator;
    const detail = Effect.sync(() => {
      reads++;
      return { state: "open" as const, headSha: head, checks: [], workflowApprovalsRequired: 0 };
    });
    const input = { cwd: "/repo", host: "github.com", repository: "acme/web", number: 1 };
    expect((yield* read(input, detail)).headSha).toBe(head);
    expect((yield* read(input, detail)).headSha).toBe(head);
    expect(reads).toBe(1);
    head = "b".repeat(40);
    expect((yield* read(input, detail)).headSha).toBe(head);
    expect(reads).toBe(2);
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(PinnedGitHubCredential, {
      host: "github.com",
      token: Redacted.make("test"),
      credentialFingerprint: "test",
    }),
  );
});

it.effect.each([
  { reason: "reserve-protected", fallback: true },
  { reason: "quota-exhausted", fallback: true },
  { reason: "core-rate-limit", fallback: true },
  { reason: "secondary-pause", fallback: false },
  { reason: "secondary-rate-limit", fallback: false },
  { reason: "authentication", fallback: false },
] as const)(
  "falls back from REST checks only for primary core limits: $reason",
  ({ reason, fallback }) => {
    const input = { cwd: "/repo", host: "github.com", repository: "acme/web", number: 1 };
    const error =
      reason === "reserve-protected" || reason === "quota-exhausted"
        ? new SourceControlRateLimit.SourceControlRateLimitPausedError({
            provider: SourceControlProviderKind.make("github"),
            host: input.host,
            resource: "core",
            pauseReason: reason,
            retryAt: 60_000,
          })
        : reason === "secondary-pause"
          ? new SourceControlRateLimit.SourceControlRateLimitPausedError({
              provider: SourceControlProviderKind.make("github"),
              host: input.host,
              pauseReason: "rate-limited",
              retryAt: 60_000,
            })
          : reason === "authentication"
            ? new GitHubRequestPolicy.GitHubApiAuthenticationError({
                host: input.host,
                operation: "revalidateChecks",
              })
            : new GitHubRequestPolicy.GitHubApiRateLimitError({
                host: input.host,
                operation: "revalidateChecks",
                ...(reason === "core-rate-limit" ? { resource: "core" } : {}),
              });
    let reads = 0;
    const detail = { state: "open" as const, headSha: "a".repeat(40), checks: [] };
    return Effect.gen(function* () {
      const read = yield* makeChecksRevalidator;
      const result = read(
        input,
        Effect.sync(() => {
          reads++;
          return detail;
        }),
      );
      if (fallback) expect(yield* result).toEqual(detail);
      else expect(yield* result.pipe(Effect.flip)).toBe(error);
      expect(reads).toBe(fallback ? 1 : 0);
    }).pipe(
      Effect.provide(Layer.mock(GitHubRest.GitHubRest)({ rest: () => Effect.fail(error) })),
      Effect.provideService(PinnedGitHubCredential, {
        host: input.host,
        token: Redacted.make("test"),
        credentialFingerprint: "test",
      }),
    );
  },
);

it.effect("does not use conditional checks under a different host's credential", () => {
  let requests = 0;
  const detail = { state: "open" as const, headSha: "a".repeat(40), checks: [] };
  return Effect.gen(function* () {
    const read = yield* makeChecksRevalidator;
    expect(
      yield* read(
        { cwd: "/repo", host: "github.enterprise.test", repository: "acme/web", number: 1 },
        Effect.succeed(detail),
      ),
    ).toEqual(detail);
    expect(requests).toBe(0);
  }).pipe(
    Effect.provide(
      Layer.mock(GitHubRest.GitHubRest)({
        rest: (input) =>
          Effect.sync(() => {
            requests++;
            return {
              status: 200,
              headers: {},
              body: input.path.endsWith("/pulls/1")
                ? JSON.stringify({
                    head: { sha: detail.headSha, repo: { id: 1 } },
                    base: { repo: { id: 1 } },
                  })
                : "{}",
              truncated: false,
              invalidUtf8: false,
            };
          }),
      }),
    ),
    Effect.provideService(PinnedGitHubCredential, {
      host: "github.com",
      token: Redacted.make("test"),
      credentialFingerprint: "test",
    }),
  );
});
