import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as GitHubRest from "./GitHubRest.ts";
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
