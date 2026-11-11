import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { PiSettings } from "../settings.ts";
import { preparePiInferenceEnvironment } from "./inference.ts";
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
      "models.json": JSON.stringify({
        providers: { native: { baseUrl: "https://native.example/v1" } },
      }),
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
      version: "1.5.2",
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
      version: "1.5.2",
    }).pipe(Effect.flip);
    assert.include(error.detail ?? "", message);
    assert.equal(yield* fs.readFileString(modelsFile), contents);
    assert.isFalse(yield* fs.exists(cacheDir));
    assert.notInclude(error.message, routeEnvironment.T3_INFERENCE_KEY);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
