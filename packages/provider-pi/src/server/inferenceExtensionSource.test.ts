// @effect-diagnostics nodeBuiltinImport:off -- The generated extension runs inside Pi, outside Effect.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { assert, it } from "@effect/vitest";

import { PI_INFERENCE_EXTENSION_SOURCE } from "./inferenceExtensionSource.ts";

interface Model {
  readonly provider: string;
  readonly id: string;
  readonly api: string;
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
}

interface StreamOptions {
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
}

interface Provider {
  readonly id: string;
  readonly models: ReadonlyArray<Model>;
  readonly auth: {
    readonly apiKey: {
      readonly resolve: (input: {
        readonly ctx: { readonly env: (name: string) => Promise<string | undefined> };
        readonly credential?: unknown;
      }) => Promise<{ readonly auth: { readonly apiKey: string } } | undefined>;
    };
  };
  readonly api: {
    readonly stream: (model: Model, context: unknown, options?: StreamOptions) => unknown;
    readonly streamSimple: (model: Model, context: unknown, options?: StreamOptions) => unknown;
  };
}

async function loadProvider() {
  const providers: Provider[] = [];
  const requests: Array<{ readonly model: Model; readonly options: StreamOptions | undefined }> =
    [];
  const environment: Record<string, string> = {
    T3_PI_INFERENCE_CONFIG: JSON.stringify({
      baseUrl: "http://127.0.0.1:4567/inference/v1",
      models: ["nested/model-id", "plain-model", "nested/model-id"],
    }),
    T3_INFERENCE_KEY: "scoped-route-key",
  };
  const source = NodeModule.stripTypeScriptTypes(
    PI_INFERENCE_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  const stream = (model: Model, _context: unknown, options?: StreamOptions) => {
    requests.push({ model, options });
  };
  await NodeVM.runInNewContext(`${source}\nt3InferenceExtension(pi)`, {
    process: { env: environment },
    URL,
    join: NodePath.join,
    getAgentDir: () => "/native/pi-agent",
    readFile: () =>
      Promise.resolve(
        '\uFEFF{\n  // "t3proxy": {} stays a comment\n  "providers": { "native": {}, },\n}',
      ),
    createProvider: (provider: Provider) => provider,
    openAICompletionsApi: () => ({ stream, streamSimple: stream }),
    pi: { registerProvider: (provider: Provider) => providers.push(provider) },
  });
  assert.lengthOf(providers, 1);
  return { provider: providers[0]!, environment, requests };
}

it("preserves host model IDs and pins scoped auth instead of native saved or explicit keys", async () => {
  const { provider, environment, requests } = await loadProvider();
  assert.equal(provider.id, "t3proxy");
  assert.deepEqual(
    provider.models.map((model) => model.id),
    ["nested/model-id", "plain-model"],
  );
  const resolved = await provider.auth.apiKey.resolve({
    ctx: { env: async (name) => environment[name] },
    credential: { type: "api_key", key: "native-saved-key" },
  });
  assert.equal(resolved?.auth.apiKey, "scoped-route-key");

  for (const stream of [provider.api.stream, provider.api.streamSimple]) {
    stream(
      { ...provider.models[0]!, headers: { Authorization: "Bearer native-model-key" } },
      {},
      {
        apiKey: "native-cli-key",
        headers: { authorization: "Bearer native-header-key", "x-request-id": "request-one" },
      },
    );
  }
  assert.lengthOf(requests, 2);
  for (const request of requests) {
    assert.equal(request.options?.apiKey, "scoped-route-key");
    assert.equal(request.options?.headers?.Authorization, "Bearer scoped-route-key");
    assert.equal(request.options?.headers?.["x-request-id"], "request-one");
    assert.isUndefined(request.options?.headers?.authorization);
    assert.isUndefined(request.model.headers?.Authorization);
  }

  environment.T3_INFERENCE_KEY = "rotated-route-key";
  provider.api.stream(provider.models[0]!, {}, { apiKey: "native-cli-key" });
  assert.equal(requests.at(-1)?.options?.apiKey, "rotated-route-key");
});

it("rejects changed destinations and unadvertised models before dispatching credentials", async () => {
  const { provider, requests } = await loadProvider();
  for (const patch of [
    { baseUrl: "https://native.example/v1" },
    { provider: "native" },
    { api: "anthropic-messages" },
    { id: "not-advertised" },
  ]) {
    assert.throws(
      () => provider.api.stream({ ...provider.models[0]!, ...patch }, {}),
      "overridden",
    );
    assert.throws(
      () => provider.api.streamSimple({ ...provider.models[0]!, ...patch }, {}),
      "overridden",
    );
  }
  assert.isEmpty(requests);
});
