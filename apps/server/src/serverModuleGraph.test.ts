import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// Vitest resolves import cycles lazily, so only a real Node load sees a module that reads a
// binding before the cycle has initialized it.
it.live("loads the server module graph from its entry", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(new URL("./server.ts", import.meta.url).href)}); process.exit(0);`,
      ]),
    );
    const [stderr, exitCode] = yield* Effect.all(
      [child.stderr.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    expect({ exitCode: Number(exitCode), stderr }).toEqual({ exitCode: 0, stderr: "" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
