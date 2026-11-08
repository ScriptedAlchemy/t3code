import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ProcessRunner from "../processRunner.ts";
import { install } from "./install.ts";

it.effect(
  "rejects a same-size corrupt release before extraction and removes the partial installation",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const failure = yield* install(directory).pipe(Effect.flip);
      expect(failure).toMatchObject({
        message: "CLIProxyAPI download failed checksum verification.",
      });
      expect(yield* fs.readDirectory(directory + "/runtime")).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(HostProcess.Platform, "darwin"),
          Layer.succeed(HostProcess.Architecture, "arm64"),
          Layer.mock(ProcessRunner.ProcessRunner)({}),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(new Uint8Array(23_371_625))),
              ),
            ),
          ),
        ),
      ),
    ),
);

it.effect("restores the saved version using the release asset for the current platform", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const legacy = { version: "8.0.61", assetId: 123, bytes: 1, sha256: "0".repeat(64) };
    const requests: string[] = [];
    yield* install(directory, legacy).pipe(
      Effect.flip,
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const endpoint = new URL(request.url).pathname.split("releases/")[1]!;
          requests.push(endpoint);
          const metadata = {
            tag_name: "v8.0.61",
            draft: false,
            prerelease: false,
            assets: [
              {
                id: 123,
                size: 1,
                digest: "sha256:" + "0".repeat(64),
                name: "CLIProxyAPI_8.0.61_darwin_aarch64.tar.gz",
              },
              {
                id: 456,
                size: 1,
                digest: "sha256:" + "0".repeat(64),
                name: "CLIProxyAPI_8.0.61_linux_amd64.tar.gz",
              },
            ],
          };
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              endpoint.startsWith("tags/")
                ? Response.json(metadata)
                : new Response(new Uint8Array(1)),
            ),
          );
        }),
      ),
    );
    expect(requests).toEqual(["tags/v8.0.61", "assets/456"]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(HostProcess.Architecture, "x64"),
        Layer.mock(ProcessRunner.ProcessRunner)({}),
      ),
    ),
  ),
);
