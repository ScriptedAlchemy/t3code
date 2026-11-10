#!/usr/bin/env node
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexTextGeneration from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { condensedCases } from "./cases.ts";
import { gradeCondensed } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string" },
    out: { type: "string" },
    baseline: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
  },
});
if (!values.model || !values.out) throw new Error("Use --model <model> --out <directory>.");
const model = values.model;
const outputDirectory = values.out;
const samples = Number(values.samples);
const selected = condensedCases.filter(
  (fixture) => values.case === undefined || values.case.split(",").includes(fixture.id),
);
if (selected.length === 0)
  throw new Error(
    `Unknown --case ${values.case}. Available cases: ${condensedCases.map((fixture) => fixture.id).join(", ")}`,
  );
const Results = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    sample: Schema.Number,
    statements: Schema.Array(
      Schema.Struct({ text: Schema.String, citations: Schema.Array(Schema.String) }),
    ),
    failures: Schema.Array(Schema.String),
    passed: Schema.Boolean,
  }),
);
const decodeSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeResults = Schema.decodeEffect(Schema.fromJsonString(Results));
const encodeResults = Schema.encodeEffect(Schema.fromJsonString(Results));

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.tap(decodeResults))
      : undefined;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-summary-eval-" });
    const generation = yield* CodexTextGeneration.makeCodexTextGeneration(decodeSettings({}));
    const results: Array<(typeof Results.Type)[number]> = [];
    for (const fixture of selected) {
      for (let sample = 0; sample < samples; sample++) {
        const { statements } = yield* generation.generateConversationSummary({
          cwd,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
          messages: fixture.summaries.map((text, index) => ({
            ref: `M${index + 1}`,
            role: "summary",
            text,
          })),
        });
        const failures = gradeCondensed(fixture, statements);
        results.push({
          id: fixture.id,
          sample,
          statements,
          failures,
          passed: failures.length === 0,
        });
      }
    }
    yield* fs.makeDirectory(outputDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(outputDirectory, "results.json"),
      yield* encodeResults(results),
    );
    if (baseline !== undefined)
      yield* fs.writeFileString(path.join(outputDirectory, "baseline.json"), baseline);
    for (const fixture of selected) {
      const rows = results.filter((row) => row.id === fixture.id);
      const passed = rows.filter((row) => row.passed).length;
      // A case fails when half or more of its samples fail.
      yield* Effect.log(
        `${fixture.id} (${fixture.kind}): ${passed}/${rows.length} samples passed, ${passed * 2 > rows.length ? "PASS" : "FAIL"}`,
      );
    }
    yield* Effect.log(`Results in ${outputDirectory}`);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-summary-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
