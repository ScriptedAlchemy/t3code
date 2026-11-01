#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CLI_RELEASE_METADATA_FILE } from "@t3tools/shared/cliRelease";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { latestServerMigrationId } from "./build-npm-launcher.ts";

const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/));
const decodeVersion = Schema.decodeUnknownEffect(Version);
const encodeMetadata = Schema.encodeEffect(
  fromJsonStringPretty(Schema.Struct({ version: Version, databaseMigration: Schema.Int })),
);

export const buildReleaseMetadata = Effect.fn("buildReleaseMetadata")(function* (input: {
  readonly version: string;
  readonly outputDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const metadata = {
    version: yield* decodeVersion(input.version),
    databaseMigration: yield* latestServerMigrationId(),
  };
  yield* fs.makeDirectory(input.outputDir, { recursive: true });
  const metadataPath = path.join(input.outputDir, CLI_RELEASE_METADATA_FILE);
  yield* fs.writeFileString(metadataPath, `${yield* encodeMetadata(metadata)}\n`);
  return metadataPath;
});

const command = Command.make(
  "build-release-metadata",
  {
    version: Flag.String("version"),
    outputDir: Flag.String("output-dir").pipe(Flag.withDefault("assets")),
  },
  buildReleaseMetadata,
).pipe(Command.withDescription("Write release version and database compatibility metadata."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
