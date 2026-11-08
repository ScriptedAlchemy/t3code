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
