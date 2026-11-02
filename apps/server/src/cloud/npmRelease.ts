import {
  ServerNpmReleaseError,
  ServerNpmReleaseInput,
  type ServerNpmRelease,
} from "@t3tools/contracts";
import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_METADATA_FILE,
  CLI_RELEASE_REPOSITORY,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
} from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/));
const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
});
const Metadata = Schema.Struct({
  version: Version,
  databaseMigration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const decodeRelease = Schema.decodeUnknownEffect(Schema.fromJsonString(Release));
const decodeReleases = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Release)));
const decodeMetadata = Schema.decodeUnknownEffect(Schema.fromJsonString(Metadata));
const decodeInput = Schema.decodeUnknownEffect(ServerNpmReleaseInput);
const RELEASE_INDEX_MAX_PAGES = 10;

// Keep the service and RPC names compatible with connected clients; this fork is released on GitHub.
export class NpmRelease extends Context.Service<
  NpmRelease,
  {
    readonly get: (
      input: ServerNpmReleaseInput,
    ) => Effect.Effect<ServerNpmRelease | null, ServerNpmReleaseError>;
  }
>()("t3/cloud/npmRelease") {}

export const make = Effect.fn("NpmRelease.make")(function* () {
  const http = yield* HttpClient.HttpClient;
  const environment = yield* HostProcess.Environment;
  const githubToken = environment.GH_TOKEN?.trim() || environment.GITHUB_TOKEN?.trim();
  const releaseBaseUrl = environment[CLI_RELEASE_BASE_URL_ENV];
  const read = Effect.fn("NpmRelease.read")(function* (
    url: string,
    options: { readonly api: boolean; readonly allowMissing: boolean },
  ) {
    const unavailable = new ServerNpmReleaseError({
      reason: "Could not read this fork's GitHub releases. Check the connection and try again.",
    });
    let request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeader(
        "Accept",
        options.api ? "application/vnd.github+json" : "application/json",
      ),
    );
    if (options.api && githubToken) {
      request = HttpClientRequest.setHeader(request, "Authorization", `Bearer ${githubToken}`);
    }
    return yield* Effect.gen(function* () {
      const response = yield* http.execute(request);
      if (response.status === 404 && options.allowMissing) return null;
      if (response.status < 200 || response.status >= 300) return yield* unavailable;
      return yield* response.text;
    }).pipe(
      Effect.timeout(Duration.seconds(15)),
      Effect.mapError(() => unavailable),
    );
  });
  const invalidRelease = () =>
    new ServerNpmReleaseError({
      reason: "GitHub returned invalid release metadata for this fork.",
    });
  const resolveVersion = Effect.fn("NpmRelease.resolveVersion")(function* (spec: string) {
    if (spec !== "latest" && spec !== "nightly") {
      const json = yield* read(
        `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases/tags/v${spec}`,
        { api: true, allowMissing: true },
      );
      if (json === null) return null;
      const release = yield* decodeRelease(json).pipe(Effect.mapError(invalidRelease));
      if (release.draft) return null;
      if (release.tag_name !== `v${spec}`) return yield* invalidRelease();
      return spec;
    }
    for (let page = 1; page <= RELEASE_INDEX_MAX_PAGES; page += 1) {
      const json = yield* read(cliReleaseIndexPageUrl(page), { api: true, allowMissing: false });
      const releases = yield* decodeReleases(json).pipe(Effect.mapError(invalidRelease));
      const version = newestCliReleaseVersion(releases, spec === "latest" ? "stable" : "nightly");
      if (version !== undefined) return version;
      if (releases.length === 0) return null;
    }
    return null;
  });
  const permits = yield* Semaphore.make(2);
  const cache = yield* Cache.make({
    capacity: 32,
    timeToLive: Duration.minutes(1),
    lookup: Effect.fn("NpmRelease.lookup")(function* (spec: string) {
      return yield* permits.withPermits(1)(
        Effect.gen(function* () {
          const version = yield* resolveVersion(spec);
          if (version === null) return null;
          const json = yield* read(
            `${cliReleaseDownloadBaseUrl(version, releaseBaseUrl)}/${CLI_RELEASE_METADATA_FILE}`,
            { api: false, allowMissing: true },
          );
          // Older releases have no migration asset; track-switch checks must keep them blocked.
          if (json === null) return { version };
          const metadata = yield* decodeMetadata(json).pipe(Effect.mapError(invalidRelease));
          if (metadata.version !== version) return yield* invalidRelease();
          return metadata;
        }),
      );
    }),
  });
  return NpmRelease.of({
    get: Effect.fn("NpmRelease.get")(function* (input) {
      const { spec } = yield* decodeInput(input).pipe(
        Effect.mapError(
          () => new ServerNpmReleaseError({ reason: "Invalid release version or track." }),
        ),
      );
      return yield* Cache.get(cache, spec);
    }),
  });
});

export const layer = Layer.effect(NpmRelease, make()).pipe(Layer.provide(FetchHttpClient.layer));
