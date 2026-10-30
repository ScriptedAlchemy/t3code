import { makeGitHubCheckFailureReader } from "./gitHubCheckFailures.ts";
import * as Metric from "effect/Metric";
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";

const appSignedOut = Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
  enabled: false,
  token: () => Effect.succeedNone,
  invalidate: () => Effect.void,
});

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function harness(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  let tokens = ["first", "second"];
  let invalidations = 0;
  let credentialReads = 0;
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.sync(() => {
          credentialReads++;
          return {
            host,
            token: Redacted.make(tokens[0]!),
            source: "gh" as const,
            fingerprint: `${host}:${tokens[0]}`,
          };
        }),
      saved: () => Effect.succeedNone,
      fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
      invalidate: () =>
        Effect.sync(() => {
          invalidations++;
          tokens = tokens.slice(1);
        }),
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)));
    }),
  );
  const layer = GitHubRest.layer.pipe(
    Layer.provide(Layer.mergeAll(credentials, http, appSignedOut)),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
  return {
    layer,
    requests,
    invalidations: () => invalidations,
    credentialReads: () => credentialReads,
  };
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

describe("environmentToken", () => {
  it("follows gh's precedence per kind of host", () => {
    const env = { GH_TOKEN: "gh", GITHUB_TOKEN: "github", GH_ENTERPRISE_TOKEN: "ghe" };
    expect(GitHubCredentials.environmentToken("github.com", env)).toBe("gh");
    expect(GitHubCredentials.environmentToken("acme.ghe.com", { GITHUB_TOKEN: "github" })).toBe(
      "github",
    );
    expect(GitHubCredentials.environmentToken("git.acme.internal", env)).toBeNull();
    expect(
      GitHubCredentials.environmentToken("git.acme.internal", {
        ...env,
        GH_HOST: "git.acme.internal",
      }),
    ).toBe("ghe");
    expect(GitHubCredentials.environmentToken("git.acme.internal", { GH_TOKEN: "gh" })).toBeNull();
  });
});

describe("GitHubRest", () => {
  it.effect("traces the operation, path and quota, never the query string or the token", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const { layer } = harness(() =>
      json({ ok: true }, { headers: { "x-ratelimit-remaining": "4800" } }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubRest.GitHubRest;
      yield* api.rest({
        host: "github.com",
        operation: "listWorkflowRuns",
        path: "repos/acme/web/actions/runs?head_sha=abc123&branch=feat%2Fx",
      });
      const send = spans.find((span) => span.name === "GitHubRest.send")!;
      expect(Object.fromEntries(send.attributes)).toMatchObject({
        "github.operation": "listWorkflowRuns",
        "github.kind": "rest",
        "url.path": "/repos/acme/web/actions/runs",
        "http.response.status_code": 200,
        "github.ratelimit.remaining": 4800,
      });
      const everything = spans
        .flatMap((span) => [...span.attributes].map(([key, value]) => `${key}=${String(value)}`))
        .join("\n");
      expect(everything).not.toContain("head_sha");
      expect(everything).not.toContain("first");
      expect(spans.some((span) => span.attributes.has("url.full"))).toBe(false);
    }).pipe(Effect.provide(layer), Effect.withTracer(tracer));
  });

  it.effect("lets an interactive request through a pause a background read recorded", () => {
    const reset = Math.floor(NOW / 1000) + 600;
    let call = 0;
    const { layer, requests } = harness(() =>
      ++call === 1
        ? json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
            },
          )
        : json({ ok: true }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubRest.GitHubRest;
      const read = { host: "github.com", operation: "sweep", path: "repos/acme/web/pulls" };
      yield* Effect.flip(api.rest(read));
      expect((yield* Effect.flip(api.rest(read)))._tag).toBe("SourceControlRateLimitPausedError");
      const merged = yield* api
        .rest({
          host: "github.com",
          operation: "merge",
          method: "PUT",
          path: "repos/acme/web/pulls/7/merge",
        })
        .pipe(Effect.provideService(SourceControlRateLimit.Interactive, true));
      expect(merged.status).toBe(200);
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps REST 403 with an exhausted quota to a rate limit, and 304 to an answer", () => {
    let call = 0;
    const { layer } = harness(() =>
      ++call === 1
        ? new Response(null, { status: 304 })
        : json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: { "retry-after": "60" },
            },
          ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubRest.GitHubRest;
      const counter = Metric.withAttributes(GitHubRequestPolicy.gitHubRequestsTotal, {
        resource: "core",
        status: "304",
      });
      const before = yield* Metric.value(counter);
      const notModified = yield* api.rest({
        host: "github.com",
        operation: "checks",
        path: "repos/acme/web/pulls/7",
        ifNoneMatch: '"abc"',
      });
      expect(notModified.status).toBe(304);
      expect((yield* Metric.value(counter)).count - before.count).toBe(1);
      const error = yield* Effect.flip(
        api.rest({ host: "github.com", operation: "checks", path: "repos/acme/web/pulls/7" }),
      );
      expect(error).toMatchObject({ _tag: "GitHubApiRateLimitError", retryAt: NOW + 60_000 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("drops a refused token so the next request asks the source again", () => {
    const { layer, requests, invalidations } = harness((request) =>
      request.headers.authorization === "Bearer first"
        ? new Response(null, { status: 401 })
        : json({ ok: true }),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubRest.GitHubRest;
      const refused = yield* Effect.flip(
        api.rest({ host: "github.com", operation: "user", path: "user" }),
      );
      expect(refused._tag).toBe("GitHubApiAuthenticationError");
      expect(invalidations()).toBe(1);
      const answered = yield* api.rest({ host: "github.com", operation: "user", path: "user" });
      expect(answered.status).toBe(200);
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        "Bearer first",
        "Bearer second",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to send a pinned credential to another host", () => {
    const { layer, requests } = harness(() => json({}));
    return Effect.gen(function* () {
      const api = yield* GitHubRest.GitHubRest;
      const error = yield* Effect.flip(
        api.rest({ host: "git.acme.internal", operation: "user", path: "user" }),
      ).pipe(
        Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
          host: "github.com",
          token: Redacted.make("pinned"),
          credentialFingerprint: "github.com:pinned",
        }),
      );
      expect(error._tag).toBe("GitHubApiAuthenticationError");
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHubCredentials", () => {
  const unexpectedHttp = HttpClient.make((request) =>
    Effect.die(`Unexpected request to ${request.url}`),
  );
  const credentialsWith = (run: SourceControlHost.SourceControlHost["Service"]["process"]["run"]) =>
    GitHubCredentials.layer.pipe(
      Layer.provide(TestSourceControlHost.layer({ process: { run } })),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, unexpectedHttp)),
    );

  it.effect("does not cache a gh failure that is not about signing in", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const first = yield* Effect.flip(credentials.get("github.com"));
      expect(first._tag).toBe("GitHubCliFailedError");
      expect((yield* credentials.get("github.com")).source).toBe("gh");
      expect(calls).toBe(2);
    }).pipe(
      Effect.provide(
        credentialsWith(() =>
          ++calls === 1
            ? Effect.fail(
                new VcsProcessTimeoutError({
                  operation: "GitHubCredentials.get",
                  command: "gh",
                  cwd: "/",
                  timeoutMs: 10_000,
                }),
              )
            : Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "token\n",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
        ),
      ),
    );
  });

  it.effect("fails with GitHubNotSignedInError when gh prints no token", () =>
    Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* Effect.flip(credentials.get("git.acme.internal"));
      expect(error._tag).toBe("GitHubNotSignedInError");
    }).pipe(
      Effect.provide(
        credentialsWith(() =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        ),
      ),
    ),
  );
});

describe("GitHub check failures", () => {
  const input = {
    cwd: "/repo",
    host: "github.com",
    repository: "acme/web",
    check: {
      name: "lint",
      status: "failure" as const,
      description: null,
      url: null,
      handle: "github-check:123:1",
    },
  };
  const job = {
    id: 123,
    run_id: 456,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    url: "https://api.github.com/repos/acme/web/actions/jobs/123",
    run_url: "https://api.github.com/repos/acme/web/actions/runs/456",
    check_run_url: "https://api.github.com/repos/acme/web/check-runs/123",
    steps: [{ name: "Run lint", conclusion: "failure" }],
  };

  it.effect(
    "follows the signed log redirect without Authorization and preserves bounded evidence",
    () => {
      const { layer, requests } = harness((request) => {
        if (request.url.includes("/annotations"))
          return json([
            { path: "a.ts", start_line: 4, annotation_level: "failure", message: "bad code" },
          ]);
        if (request.url.endsWith("/logs"))
          return new Response(null, {
            status: 302,
            headers: { location: "https://blob.example/log?signature=secret" },
          });
        if (request.url.startsWith("https://blob.example/"))
          return new Response("2026-10-30T12:00:00Z ##[error]bad code\n");
        return json(job);
      });
      return Effect.gen(function* () {
        const read = yield* makeGitHubCheckFailureReader;
        const result = yield* read(input);
        expect(result).toMatchObject({
          attempt: 1,
          failedSteps: ["Run lint"],
          annotations: [{ path: "a.ts", startLine: 4, message: "bad code" }],
          log: { _tag: "excerpt", text: "##[error]bad code", totalLines: 1, truncated: false },
        });
        expect(result).not.toHaveProperty("required");
        expect(requests).toHaveLength(4);
        expect(requests[0]?.headers.authorization).toBe("Bearer first");
        expect(requests[3]?.headers).not.toHaveProperty("authorization");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([
    {
      name: "running",
      job: { ...job, status: "in_progress" },
      logStatus: 200,
      reason: "still-running",
      requests: 1,
    },
    {
      name: "wrong check",
      job: { ...job, check_run_url: "https://api.github.com/repos/acme/web/check-runs/999" },
      logStatus: 200,
      reason: "not-actions",
      requests: 1,
    },
    {
      name: "wrong repository",
      job: { ...job, run_url: "https://api.github.com/repos/other/web/actions/runs/456" },
      logStatus: 200,
      reason: "not-actions",
      requests: 1,
    },
    {
      name: "wrong attempt",
      job: { ...job, run_attempt: 2 },
      logStatus: 200,
      reason: "not-actions",
      requests: 1,
    },
    { name: "expired", job, logStatus: 404, reason: "expired", requests: 3 },
    { name: "gone", job, logStatus: 410, reason: "expired", requests: 3 },
    { name: "forbidden", job, logStatus: 403, reason: "no-access", requests: 3 },
  ])("returns $reason for $name without extra reads", (test) => {
    const { layer, requests } = harness((request) =>
      request.url.includes("/annotations")
        ? json([])
        : request.url.endsWith("/logs")
          ? json({ message: "Unavailable" }, { status: test.logStatus })
          : json(test.job),
    );
    return Effect.gen(function* () {
      const read = yield* makeGitHubCheckFailureReader;
      expect((yield* read(input)).log).toEqual({ _tag: "unavailable", reason: test.reason });
      expect(requests).toHaveLength(test.requests);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps quota refusals typed and pauses subsequent reads", () => {
    const { layer, requests } = harness((request) =>
      request.url.includes("/annotations")
        ? json([])
        : request.url.endsWith("/logs")
          ? json(
              { message: "API rate limit exceeded" },
              { status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "60" } },
            )
          : json(job),
    );
    return Effect.gen(function* () {
      const read = yield* makeGitHubCheckFailureReader;
      expect((yield* Effect.flip(read(input)))._tag).toBe("GitHubApiRateLimitError");
      expect((yield* Effect.flip(read(input)))._tag).toBe("SourceControlRateLimitPausedError");
      expect(requests).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });
  it.effect.each([403, 404])(
    "reports an unavailable job (%s) without requesting its logs",
    (status) => {
      const { layer, requests } = harness(() => json({ message: "Unavailable" }, { status }));
      return Effect.gen(function* () {
        const read = yield* makeGitHubCheckFailureReader;
        expect((yield* read(input)).log).toEqual({
          _tag: "unavailable",
          reason: status === 403 ? "no-access" : "not-actions",
        });
        expect(requests).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );
});
