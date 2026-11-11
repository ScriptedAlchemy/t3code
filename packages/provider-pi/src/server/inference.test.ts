import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { PiSettings } from "../settings.ts";
import {
  MINIMUM_PI_INFERENCE_VERSION,
  preparePiInferenceEnvironment,
  recordPiVersion,
} from "./inference.ts";
import { PI_INFERENCE_EXTENSION_SOURCE } from "./inferenceExtensionSource.ts";

const routedSettings = Schema.decodeSync(PiSettings)({ inferenceEnabled: true });
const routeEnvironment = {
  T3_PI_INFERENCE_CONFIG: JSON.stringify({
    baseUrl: "http://127.0.0.1:4567/inference/v1",
    models: ["host/model-one", "model-two"],
  }),
  T3_INFERENCE_KEY: "scoped-test-route-key",
};

it.effect("keeps native Pi files and credentials unchanged through routing on and off", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-inference-" });
    const agentDir = path.join(directory, "native-agent");
    yield* fs.makeDirectory(agentDir);
    const originals = {
      // Pi accepts line comments and trailing commas in models.json.
      "models.json":
        '{\n  // "t3proxy": {} stays a comment\n  "providers": { "native": { "baseUrl": "https://native.example/v1" }, },\n}',
      "auth.json": JSON.stringify({ t3proxy: { type: "api_key", key: "native-saved-key" } }),
      "settings.json": JSON.stringify({ extensions: ["./native-extension.ts"] }),
    };
    for (const [filename, contents] of Object.entries(originals)) {
      yield* fs.writeFileString(path.join(agentDir, filename), contents);
    }
    const environment = {
      ...routeEnvironment,
      HOME: directory,
      PI_CODING_AGENT_DIR: "./native-agent",
      ANTHROPIC_API_KEY: "native-account-key",
      T3_PI_INFERENCE_EXTENSION: "/inherited/untrusted-extension.ts",
    };
    const prepared = yield* preparePiInferenceEnvironment({
      config: routedSettings,
      environment,
      cacheDir: path.join(directory, "t3-cache"),
      cwd: directory,
      version: MINIMUM_PI_INFERENCE_VERSION,
    });
    assert.equal(prepared.PI_CODING_AGENT_DIR, "./native-agent");
    assert.equal(prepared.ANTHROPIC_API_KEY, "native-account-key");
    assert.equal(prepared.T3_INFERENCE_KEY, routeEnvironment.T3_INFERENCE_KEY);
    assert.notEqual(prepared.T3_PI_INFERENCE_EXTENSION, environment.T3_PI_INFERENCE_EXTENSION);
    const source = yield* fs.readFileString(prepared.T3_PI_INFERENCE_EXTENSION!);
    assert.equal(source, PI_INFERENCE_EXTENSION_SOURCE);
    assert.notInclude(source, routeEnvironment.T3_INFERENCE_KEY);
    assert.notInclude(source, "host/model-one");

    const native = yield* preparePiInferenceEnvironment({
      config: { ...routedSettings, inferenceEnabled: false },
      environment: prepared,
      cacheDir: path.join(directory, "t3-cache"),
    });
    assert.isUndefined(native.T3_PI_INFERENCE_EXTENSION);
    assert.isUndefined(native.T3_PI_INFERENCE_CONFIG);
    assert.isUndefined(native.T3_INFERENCE_KEY);
    assert.equal(native.PI_CODING_AGENT_DIR, "./native-agent");
    assert.equal(native.ANTHROPIC_API_KEY, "native-account-key");
    for (const [filename, contents] of Object.entries(originals)) {
      assert.equal(yield* fs.readFileString(path.join(agentDir, filename)), contents);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { contents: '{"providers":', message: "valid Pi models.json" },
  {
    contents: JSON.stringify({ providers: { t3proxy: { baseUrl: "https://native.example/v1" } } }),
    message: "already defines t3proxy",
  },
  {
    contents: '{ "providers": { "t3proxy": {}, }, } // native',
    message: "already defines t3proxy",
  },
])("refuses incompatible native config without rewriting it: $message", ({ contents, message }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-inference-config-" });
    const modelsFile = path.join(directory, "models.json");
    const cacheDir = path.join(directory, "cache");
    yield* fs.writeFileString(modelsFile, contents);
    const error = yield* preparePiInferenceEnvironment({
      config: routedSettings,
      environment: { ...routeEnvironment, PI_CODING_AGENT_DIR: directory },
      cacheDir,
      version: MINIMUM_PI_INFERENCE_VERSION,
    }).pipe(Effect.flip);
    assert.include(error.detail ?? "", message);
    assert.equal(yield* fs.readFileString(modelsFile), contents);
    assert.isFalse(yield* fs.exists(cacheDir));
    assert.notInclude(error.message, routeEnvironment.T3_INFERENCE_KEY);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("measures the Pi version once per binary and again after an unsupported result", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-inference-version-" });
    const reported = ["1.3.0", MINIMUM_PI_INFERENCE_VERSION];
    let spawns = 0;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        const version = reported[Math.min(spawns, reported.length - 1)];
        spawns += 1;
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(900_000_002),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.succeed(new TextEncoder().encode(`pi ${version}\n`)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const config = { ...routedSettings, binaryPath: "pi-version-probe-test" };
    const environment = { ...routeEnvironment, PI_CODING_AGENT_DIR: directory };
    const openSession = preparePiInferenceEnvironment({
      config,
      environment,
      cacheDir: path.join(directory, "cache"),
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    const outdated = yield* openSession.pipe(Effect.flip);
    assert.include(outdated.detail ?? "", MINIMUM_PI_INFERENCE_VERSION);
    yield* openSession;
    yield* openSession;
    assert.equal(spawns, 2);

    recordPiVersion(config, environment, "1.3.0");
    yield* openSession;
    assert.equal(spawns, 3);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
