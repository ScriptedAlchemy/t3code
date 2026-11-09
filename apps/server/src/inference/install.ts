// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import { InferenceProxyError } from "@t3tools/contracts";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ProcessRunner from "../processRunner.ts";

export const proxyVersion = "8.0.60";
export const Release = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)),
});
const VerifiedRelease = Schema.Struct({
  ...Release.fields,
  target: Schema.String,
  assetId: Schema.Int.check(Schema.isGreaterThan(0)),
  bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 * 1024 * 1024 })),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
type Release = typeof Release.Type;
const archives: Readonly<Record<string, Omit<typeof VerifiedRelease.Type, "version" | "target">>> =
  {
    "darwin-arm64": {
      assetId: 721818165,
      bytes: 23371625,
      sha256: "9be68e64fc614a5474b98d310bb9057d6bdecb619cedec01febbb4073fdb19df",
    },
    "darwin-x64": {
      assetId: 721822119,
      bytes: 25319649,
      sha256: "8892224d75f3d29a33efd0e4b8a00bb97505266cf2b9bc80d1adb3a787d89910",
    },
    "linux-arm64": {
      assetId: 721818364,
      bytes: 22730665,
      sha256: "e1fefdaa87479cb35428a8d484ea1762c80eb58be3c7c37555977bca4eebf6c5",
    },
    "linux-x64": {
      assetId: 721818025,
      bytes: 25226924,
      sha256: "d74beb67b642eb7940384dcb050f23dcd305f2af25019aa5af88988f803c5425",
    },
    "win32-arm64": {
      assetId: 721821627,
      bytes: 22876276,
      sha256: "e265ba0088fe3f504e5e80d0aaa49d7272f9d3d1431ba03ee46df9583831504c",
    },
    "win32-x64": {
      assetId: 721819693,
      bytes: 25646977,
      sha256: "c81a2c51aeab819c6e4840ad62f8d8f4143706b9fa7682f4a769683e0044fff1",
    },
  };
const UpstreamRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  assets: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      size: Schema.Int,
      digest: Schema.NullOr(Schema.String),
      name: Schema.String,
    }),
  ),
});

const decodeUpstream = Schema.decodeUnknownEffect(UpstreamRelease);
const decodeRelease = Schema.decodeEffect(VerifiedRelease);
export const resolveRelease = Effect.fn("InferenceProxy.resolveRelease")(function* (
  requestedVersion: string | undefined,
) {
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const client = yield* HttpClient.HttpClient;
  const endpoint = requestedVersion === undefined ? "latest" : "tags/v" + requestedVersion;
  const response = yield* client
    .get("https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/" + endpoint, {
      headers: { accept: "application/vnd.github+json", "user-agent": "T3-Code" },
    })
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  const release = yield* decodeUpstream(yield* response.json);
  const version = release.tag_name.replace(/^v/, "");
  const name = `CLIProxyAPI_${version}_${platform === "win32" ? "windows" : platform}_${arch === "arm64" ? "aarch64" : "amd64"}${platform === "win32" ? ".zip" : ".tar.gz"}`;
  const asset = release.assets.find((a) => a.name === name);
  if (
    !archives[`${platform}-${arch}`] ||
    (requestedVersion !== undefined && version !== requestedVersion) ||
    release.draft ||
    release.prerelease ||
    !asset?.digest?.startsWith("sha256:") ||
    !version.startsWith("8.")
  )
    return yield* new InferenceProxyError({
      message: "No verified, compatible CLIProxyAPI release is available for this host.",
    });
  return yield* decodeRelease({
    version,
    target: `${platform}-${arch}`,
    assetId: asset.id,
    bytes: asset.size,
    sha256: asset.digest.slice(7),
  });
}, Effect.timeout("10 seconds"));

export const install = Effect.fn("InferenceProxy.install")(function* (
  directory: string,
  release?: Release | typeof VerifiedRelease.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const target = platform + "-" + arch;
  const pinned = archives[target];
  if (!pinned)
    return yield* new InferenceProxyError({
      message: "CLIProxyAPI is unavailable for this platform.",
    });
  const version = release?.version ?? proxyVersion;
  const runtime = path.join(directory, "runtime", version + "-" + target);
  const binary = platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
  const executable = path.join(runtime, binary);
  if (yield* fs.exists(executable)) return executable;
  const archive =
    version === proxyVersion
      ? pinned
      : release && "target" in release && release.target === target
        ? release
        : yield* resolveRelease(version);
  yield* fs.makeDirectory(path.dirname(runtime), { recursive: true, mode: 0o700 });
  const temp = yield* fs.makeTempDirectoryScoped({ directory: path.dirname(runtime) });
  const client = yield* HttpClient.HttpClient;
  const asset = path.join(temp, "archive");
  const hash = NodeCrypto.createHash("sha256");
  let received = 0;
  yield* client
    .get(
      `https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/assets/${archive.assetId}`,
      {
        headers: { accept: "application/octet-stream", "user-agent": "T3-Code" },
      },
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) =>
        response.stream.pipe(
          Stream.tap((chunk) =>
            Effect.suspend(() => {
              received += chunk.byteLength;
              if (received > archive.bytes)
                return Effect.fail(
                  new InferenceProxyError({
                    message: "CLIProxyAPI download exceeds its pinned size.",
                  }),
                );
              hash.update(chunk);
              return Effect.void;
            }),
          ),
          Stream.run(fs.sink(asset, { flag: "wx", mode: 0o600 })),
        ),
      ),
      Effect.timeout("3 minutes"),
    );
  if (received !== archive.bytes || hash.digest("hex") !== archive.sha256)
    return yield* new InferenceProxyError({
      message: "CLIProxyAPI download failed checksum verification.",
    });
  const stage = path.join(temp, "install");
  yield* fs.makeDirectory(stage);
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner.run({
    command: cliArchiveTarCommand(platform, yield* HostProcess.Environment),
    args: ["-xf", asset, "-C", stage, binary, "LICENSE"],
  });
  if (result.code !== 0)
    return yield* new InferenceProxyError({
      message: "Could not extract the verified CLIProxyAPI release.",
    });
  yield* fs.rename(stage, runtime);
  return executable;
}, Effect.scoped);
