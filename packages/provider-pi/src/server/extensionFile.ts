import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export const materializePiExtension = Effect.fn("materializePiExtension")(function* (
  cacheDir: string,
  filename: string,
  source: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  const dest = `${cacheDir.replace(/\\/g, "/")}/${filename}`;
  const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== source) {
    // Pi may read this while another launch materializes it; rename only complete files.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const stagingDir = yield* fs.makeTempDirectoryScoped({ directory: cacheDir });
        const staging = `${stagingDir.replace(/\\/g, "/")}/${filename}`;
        yield* fs.writeFileString(staging, source);
        yield* fs.rename(staging, dest).pipe(Effect.retry({ times: 3 }));
      }),
    );
  }
  return dest;
});
