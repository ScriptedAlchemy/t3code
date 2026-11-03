#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - command-line eval arguments and reproducible input digests.
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BlindModelEvaluationPacket,
  ClaudeSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ModelEvaluationVerdict,
} from "@t3tools/contracts";
import {
  buildModelEvaluationPrompt,
  MODEL_EVALUATION_RUBRIC_VERSION,
} from "@t3tools/provider-core/server/modelEvaluation";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { modelEvaluationCases } from "./cases.ts";
import { gradeModelEvaluation } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "haiku" },
    baseline: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!values.out) throw new Error("Use --out <directory> [--model <Claude model>] [--dry-run].");
const outDirectory = values.out;
const samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 20)
  throw new Error("--samples must be an integer from 1 to 20.");
const requested = new Set(
  values.case?.flatMap((value) => value.split(",")) ??
    modelEvaluationCases.map((entry) => entry.id),
);
const selected = modelEvaluationCases.filter((entry) => requested.has(entry.id));
const unknown = [...requested].filter((id) => !selected.some((entry) => entry.id === id));
if (unknown.length || selected.length === 0)
  throw new Error(`Unknown or empty --case selection: ${unknown.join(", ")}`);

const Baseline = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      case: Schema.String,
      model: Schema.String,
      fixtureHash: Schema.String,
      graderHash: Schema.String,
      pass: Schema.NullOr(Schema.Boolean),
    }),
  ),
);
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePacket = Schema.decodeUnknownSync(BlindModelEvaluationPacket);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeBaseline = Schema.decodeUnknownEffect(Baseline);

interface Row {
  readonly case: string;
  readonly source: string;
  readonly model: string;
  readonly sample: number;
  readonly rubricVersion: string;
  readonly fixtureHash: string;
  readonly graderHash: string;
  readonly promptHash: string;
  readonly pass: boolean | null;
  readonly failures: readonly string[];
  readonly verdict: ModelEvaluationVerdict | null;
  readonly error: string | null;
  readonly latencyMs: number | null;
}

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const graderHash = hash(yield* fs.readFileString(path.join(import.meta.dirname, "grade.ts")));
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeBaseline))
      : [];
    const prepared = selected.map((fixture) => {
      const packet = decodePacket(fixture.packet);
      const { prompt } = buildModelEvaluationPrompt(packet);
      const fixtureHash = hash(encodeJson({ kind: fixture.kind, packet }));
      const previous = baseline.filter((row) => row.case === fixture.id);
      if (
        values.baseline &&
        (previous.length === 0 ||
          previous.some(
            (row) =>
              row.model !== values.model ||
              row.fixtureHash !== fixtureHash ||
              row.graderHash !== graderHash ||
              row.pass === null,
          ))
      ) {
        throw new Error(
          `Baseline for ${fixture.id} must use the same model, fixture, and grader, with real graded samples.`,
        );
      }
      return { fixture, packet, prompt, promptHash: hash(prompt), fixtureHash, previous };
    });
    yield* fs.makeDirectory(outDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(outDirectory, "prompts.json"),
      encodeJson(
        prepared.map(({ fixture, packet, prompt, promptHash }) => ({
          id: fixture.id,
          packet,
          prompt,
          promptHash,
        })),
      ),
    );
    const generation = values["dry-run"]
      ? null
      : yield* Effect.gen(function* () {
          const { makeClaudeTextGeneration } = yield* Effect.promise(
            () => import("../../apps/server/src/textGeneration/ClaudeTextGeneration.ts"),
          );
          return yield* makeClaudeTextGeneration(yield* decodeClaudeSettings({}));
        });
    const cwd =
      generation === null
        ? ""
        : yield* fs.makeTempDirectoryScoped({ prefix: "t3-model-evaluation-eval-" });
    const rows: Row[] = [];
    for (const item of prepared) {
      for (let sample = 0; sample < samples; sample++) {
        const base = {
          case: item.fixture.id,
          source: item.fixture.source,
          model: values.model,
          sample,
          rubricVersion: MODEL_EVALUATION_RUBRIC_VERSION,
          fixtureHash: item.fixtureHash,
          graderHash,
          promptHash: item.promptHash,
        };
        if (generation === null) {
          rows.push({
            ...base,
            pass: null,
            failures: [],
            verdict: null,
            error: null,
            latencyMs: null,
          });
        } else {
          const result = yield* generation
            .generateModelEvaluation({
              cwd,
              packet: item.packet,
              modelSelection: {
                instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent")),
                model: values.model,
              },
            })
            .pipe(
              Effect.timed,
              Effect.map(([duration, verdict]) => ({
                verdict,
                error: null,
                latencyMs: Duration.toMillis(duration),
              })),
              Effect.orElseSucceed((error) => ({
                verdict: null,
                error: String(error).slice(0, 2_000),
                latencyMs: null,
              })),
            );
          const grading =
            result.verdict === null
              ? { pass: false, failures: ["Evaluation call failed."] }
              : gradeModelEvaluation(item.fixture, result.verdict);
          rows.push({ ...base, ...result, ...grading });
        }
        yield* fs.writeFileString(path.join(outDirectory, "results.json"), encodeJson(rows));
      }
    }
    const summaries = prepared.map((item) => {
      const own = rows.filter((row) => row.case === item.fixture.id);
      const passed = own.filter((row) => row.pass === true).length;
      const baselinePassed = item.previous.filter((row) => row.pass === true).length;
      return {
        id: item.fixture.id,
        passed,
        samples: own.length,
        pass: generation === null ? null : passed > own.length / 2,
        baseline: item.previous.length ? `${baselinePassed}/${item.previous.length}` : "—",
      };
    });
    const calls = generation === null ? 0 : rows.length;
    const report = [
      "# Blind model evaluation",
      "",
      `Model: ${values.model}. Rubric: ${MODEL_EVALUATION_RUBRIC_VERSION}. ${generation === null ? "Dry run; no model calls or quality scores." : "Each case passes only when a strict majority of its samples pass."}`,
      "",
      "| Case | Passing samples | Result | Baseline samples |",
      "| --- | --- | --- | --- |",
      ...summaries.map(
        (item) =>
          `| ${item.id} | ${generation === null ? "—" : `${item.passed}/${item.samples}`} | ${item.pass === null ? "Dry run" : item.pass ? "Pass" : "Fail"} | ${item.baseline} |`,
      ),
      "",
      `Provider calls: ${calls}. ${calls === 0 ? "Cost: $0." : "Token usage and dollar cost are not exposed by this CLI operation; consult the configured provider's usage records."}`,
      "",
      "The fixture, grader, and prompt hashes are saved with every sample. Baseline comparison requires identical fixtures, grader, and model. Review the raw verdicts before interpreting these guards as general judge quality.",
      "",
    ].join("\n");
    yield* fs.writeFileString(path.join(outDirectory, "summary.md"), report);
    yield* fs.writeFileString(
      path.join(outDirectory, "summary.json"),
      encodeJson({
        model: values.model,
        rubricVersion: MODEL_EVALUATION_RUBRIC_VERSION,
        dryRun: generation === null,
        providerCalls: calls,
        tokenUsage: null,
        costUSD: calls === 0 ? 0 : null,
        cases: summaries,
      }),
    );
    process.stdout.write(report);
    if (summaries.some((item) => item.pass === false)) process.exitCode = 1;
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
