import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class ProjectMemoryBuildError extends Schema.TaggedError<ProjectMemoryBuildError>()(
  "ProjectMemoryBuildError",
  {
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return "Project memory native build failed.";
  }
}

export const stageProjectMemory = Effect.fn("stageProjectMemory")(function* (input: {
  readonly repoRoot: string;
  readonly outputDir: string;
  readonly targets?: readonly string[];
}) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(input.outputDir, { recursive: true, force: true });
  for (const target of input.targets ?? [undefined]) {
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          path.join(input.repoRoot, "native/project-memory/build.mjs"),
          "--out",
          input.outputDir,
          ...(target === undefined ? [] : ["--target", target]),
        ],
        { cwd: input.repoRoot, stdout: "inherit", stderr: "inherit" },
      ),
    );
    const exitCode = yield* child.exitCode;
    if (exitCode !== 0) return yield* new ProjectMemoryBuildError({ exitCode });
  }
});
