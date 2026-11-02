import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import * as NpmRelease from "./npmRelease.ts";
import { trackSwitchBlockReason } from "./selfUpdate.ts";

const version = "0.1.5-nightly.20261030.1";
const repository = "https://api.github.com/repos/ScriptedAlchemy/t3code/releases";
const indexUrl = `${repository}?per_page=100&page=1`;
const metadataUrl = (releaseVersion: string) =>
  `https://github.com/ScriptedAlchemy/t3code/releases/download/v${releaseVersion}/t3-release.json`;
const json = (value: unknown) => new Response(JSON.stringify(value));
const makeService = (
  reply: (request: HttpClientRequest.HttpClientRequest) => Response,
  environment: NodeJS.ProcessEnv = {},
) =>
  NpmRelease.make().pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, reply(request))),
      ),
    ),
    Effect.provideService(HostProcess.Environment, environment),
  );

it.effect.each([
  { spec: version, expectedVersion: version },
  { spec: "nightly", expectedVersion: version },
  { spec: "latest", expectedVersion: "0.1.4" },
])("resolves this fork's $spec release instead of the upstream npm package", (fixture) =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const lookupUrl = fixture.spec === version ? `${repository}/tags/v${version}` : indexUrl;
    const service = yield* makeService((request) => {
      requests.push(request.url);
      if (request.url === lookupUrl) {
        return json(
          fixture.spec === version
            ? { tag_name: `v${version}` }
            : [
                { tag_name: "v9.9.9-nightly.20261031.1", draft: true },
                { tag_name: "v9.9.9", draft: true },
                { tag_name: "v9.9.9-preview.20261031.1" },
                { tag_name: `v${version}` },
                { tag_name: "v0.1.4" },
              ],
        );
      }
      expect(request.url).toBe(metadataUrl(fixture.expectedVersion));
      return json({ version: fixture.expectedVersion, databaseMigration: 85 });
    });
    const expected = { version: fixture.expectedVersion, databaseMigration: 85 };
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(requests).toEqual([lookupUrl, metadataUrl(fixture.expectedVersion)]);
    yield* TestClock.adjust("1 minute");
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(requests).toHaveLength(4);
  }),
);

it.effect("finds stable releases beyond a page of nightlies", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const service = yield* makeService((request) => {
      requests.push(request.url);
      if (request.url === indexUrl) return json([{ tag_name: `v${version}` }]);
      if (request.url === `${repository}?per_page=100&page=2`) {
        return json([{ tag_name: "v0.1.4" }]);
      }
      return json({ version: "0.1.4", databaseMigration: 42 });
    });
    expect(yield* service.get({ spec: "latest" })).toEqual({
      version: "0.1.4",
      databaseMigration: 42,
    });
    expect(requests).toEqual([indexUrl, `${repository}?per_page=100&page=2`, metadataUrl("0.1.4")]);
  }),
);

it.effect.each(["missing tag", "draft", "empty track"])(
  "treats an unpublished fork release as unavailable: %s",
  (scenario) =>
    Effect.gen(function* () {
      let requests = 0;
      const service = yield* makeService(() => {
        requests++;
        return scenario === "missing tag"
          ? new Response("", { status: 404 })
          : json(scenario === "draft" ? { tag_name: `v${version}`, draft: true } : []);
      });
      expect(
        yield* service.get({ spec: scenario === "empty track" ? "latest" : version }),
      ).toBeNull();
      expect(requests).toBe(1);
    }),
);

it.effect("keeps old releases with no migration asset blocked from crossing tracks", () =>
  Effect.gen(function* () {
    const service = yield* makeService((request) =>
      request.url === indexUrl
        ? json([{ tag_name: `v${version}` }])
        : new Response("", { status: 404 }),
    );
    const release = yield* service.get({ spec: "nightly" });
    expect(release).toEqual({ version });
    expect(
      trackSwitchBlockReason({
        serverVersion: "0.1.4",
        targetVersion: release!.version,
        targetDatabaseMigration: release!.databaseMigration,
        databaseMigration: () => 85,
      }),
    ).toContain("Cannot confirm");
  }),
);

it.effect.each([
  { scope: "index", status: 404, body: "sensitive" },
  { scope: "index", status: 403, body: "sensitive" },
  { scope: "index", status: 500, body: "sensitive" },
  { scope: "index", status: 200, body: "not json" },
  { scope: "index", status: 200, body: "{}" },
  { scope: "tag", status: 200, body: '{"tag_name":"v9.9.9"}' },
  { scope: "metadata", status: 500, body: "sensitive" },
  { scope: "metadata", status: 200, body: "not json" },
  {
    scope: "metadata",
    status: 200,
    body: JSON.stringify({ version: "9.9.9", databaseMigration: 85 }),
  },
  { scope: "metadata", status: 200, body: JSON.stringify({ version, databaseMigration: -1 }) },
  { scope: "metadata", status: 200, body: JSON.stringify({ version, databaseMigration: 1.5 }) },
  { scope: "metadata", status: 200, body: JSON.stringify({ version }) },
])("reports failed or invalid release metadata instead of an unpublished release: %j", (fixture) =>
  Effect.gen(function* () {
    const service = yield* makeService((request) => {
      if (fixture.scope === "metadata" && request.url === indexUrl) {
        return json([{ tag_name: `v${version}` }]);
      }
      return new Response(fixture.body, { status: fixture.status });
    });
    const found = yield* service
      .get({ spec: fixture.scope === "tag" ? version : "nightly" })
      .pipe(Effect.result);
    expect(Result.isFailure(found)).toBe(true);
    if (Result.isFailure(found)) {
      expect(found.failure).toBeInstanceOf(ServerNpmReleaseError);
      expect(found.failure.message).not.toContain("sensitive");
    }
  }),
);

it.effect("authenticates the fork API without sending the GitHub token to an asset mirror", () =>
  Effect.gen(function* () {
    const service = yield* makeService(
      (request) => {
        if (request.url === indexUrl) {
          expect(request.headers.authorization).toBe("Bearer test-token");
          return json([{ tag_name: `v${version}` }]);
        }
        expect(request.url).toBe(`https://mirror.example/v${version}/t3-release.json`);
        expect(request.headers.authorization).toBeUndefined();
        return json({ version, databaseMigration: 85 });
      },
      { GH_TOKEN: "test-token", T3CODE_RELEASE_BASE_URL: "https://mirror.example/" },
    );
    expect(yield* service.get({ spec: "nightly" })).toEqual({ version, databaseMigration: 85 });
  }),
);

it.effect("times out a stalled release response", () =>
  Effect.gen(function* () {
    const service = yield* makeService(() => new Response(new ReadableStream()));
    const stalled = yield* service.get({ spec: "latest" }).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("15 seconds");
    expect(Result.isFailure(yield* Fiber.join(stalled))).toBe(true);
  }),
);

it.effect("runs at most two release lookups at once", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<void>();
    const release = yield* Deferred.make<void>();
    let running = 0;
    let peak = 0;
    const service = yield* NpmRelease.make().pipe(
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            peak = Math.max(peak, ++running);
            yield* Queue.offer(started, undefined);
            yield* Deferred.await(release);
            running--;
            return HttpClientResponse.fromWeb(request, new Response("", { status: 404 }));
          }),
        ),
      ),
    );
    const lookups = yield* Effect.forEach(
      ["1.0.0", "1.0.1", "1.0.2"],
      (spec) => service.get({ spec }),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
    yield* Queue.take(started);
    yield* Queue.take(started);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(lookups)).toEqual([null, null, null]);
    expect(peak).toBe(2);
  }),
);

it.effect.each(["--registry=https://example.com", "../other", "other-package@latest", "*", ""])(
  "rejects invalid release specs before requesting a release: %s",
  (spec) =>
    Effect.gen(function* () {
      const service = yield* makeService(() => {
        throw new Error("invalid specs must not request a release");
      });
      expect(Result.isFailure(yield* service.get({ spec }).pipe(Effect.result))).toBe(true);
    }),
);
