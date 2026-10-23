// @effect-diagnostics nodeBuiltinImport:off - resolves the server entry the smoke launches.
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { smokeCodeIntelligenceProcess } from "./code-intelligence-smoke.ts";

const serverEntry = NodeURL.fileURLToPath(new URL("../../apps/server/src/bin.ts", import.meta.url));

it.live("answers a code query through the server's analysis process", () =>
  smokeCodeIntelligenceProcess(process.execPath, [
    "--experimental-strip-types",
    "--liftoff-only",
    serverEntry,
  ]),
);

it.live("fails when the analysis process exits without answering", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      smokeCodeIntelligenceProcess(process.execPath, ["-e", "process.exit(3)"]),
    );
    assert.equal(error._tag, "CodeIntelligenceSmokeError");
    assert.include(error.detail, "exited with 3");
  }),
);
