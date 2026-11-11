export const T3_PI_INFERENCE_CONFIG_ENV = "T3_PI_INFERENCE_CONFIG";
export const T3_PI_INFERENCE_EXTENSION_ENV = "T3_PI_INFERENCE_EXTENSION";
export const T3_INFERENCE_KEY_ENV = "T3_INFERENCE_KEY";
export const PI_INFERENCE_PROVIDER = "t3proxy";
export const PI_INFERENCE_EXTENSION_FILENAME = "pi-t3-inference-extension.ts";

// Pi's models.json reader accepts a BOM, line comments, and trailing commas. Keep this self-contained.
export const stripPiJsonSyntax = (input: string) =>
  input
    .replace(/^\uFEFF/, "")
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
      (match, tail?: string) => tail ?? (match[0] === '"' ? match : ""),
    );

// Pi supplies these current Provider constructors in its npm and bundled extension runtimes.
export const PI_INFERENCE_EXTENSION_SOURCE = `\
import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi, type Api, type Model, type ProviderStreams, type StreamOptions } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_ENV = ${JSON.stringify(T3_PI_INFERENCE_CONFIG_ENV)};
const KEY_ENV = ${JSON.stringify(T3_INFERENCE_KEY_ENV)};
const PROVIDER = ${JSON.stringify(PI_INFERENCE_PROVIDER)};
const stripPiJsonSyntax = ${stripPiJsonSyntax.toString()};

export default async function t3InferenceExtension(pi: ExtensionAPI) {
  let config: { baseUrl: string; models: string[] };
  try {
    const value = JSON.parse(process.env[CONFIG_ENV] ?? "");
    if (
      typeof value !== "object" || value === null ||
      typeof value.baseUrl !== "string" ||
      !Array.isArray(value.models) ||
      !value.models.every((id: unknown) => typeof id === "string" && id.trim().length > 0)
    ) throw new Error();
    const url = new URL(value.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error();
    config = value;
  } catch {
    throw new Error("T3 inference configuration is invalid. Reconnect the Pi inference host in T3 Code.");
  }
  if (!process.env[KEY_ENV]?.trim())
    throw new Error("T3 inference credentials are unavailable. Reconnect the Pi inference host in T3 Code.");

  // Native overrides sit above registered providers, so reserve this one name without rewriting the file.
  let nativeModels: string | undefined;
  try {
    nativeModels = await readFile(join(getAgentDir(), "models.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("T3 inference could not read Pi models.json.");
  }
  if (nativeModels !== undefined) {
    let nativeConfig: { providers?: Record<string, unknown> };
    try {
      nativeConfig = JSON.parse(stripPiJsonSyntax(nativeModels));
      if (typeof nativeConfig !== "object" || nativeConfig === null) throw new Error();
    } catch {
      throw new Error("T3 inference requires a valid Pi models.json. Your file has not been changed.");
    }
    if (Object.hasOwn(nativeConfig.providers ?? {}, PROVIDER))
      throw new Error("Pi models.json already defines t3proxy. Rename that provider before enabling T3 inference.");
  }

  const ids = new Set(config.models);
  const api = openAICompletionsApi();
  const withoutAuthorization = (headers: Record<string, string> | undefined) =>
    Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== "authorization"));
  const checkedModel = (model: Model<Api>) => {
    if (model.provider !== PROVIDER || !ids.has(model.id) ||
        model.api !== "openai-completions" || model.baseUrl !== config.baseUrl)
      throw new Error("Pi's t3proxy model was overridden. Reconnect the inference host in T3 Code.");
    return { ...model, headers: withoutAuthorization(model.headers) };
  };
  const routeOptions = (options: StreamOptions | undefined): StreamOptions => {
    const key = process.env[KEY_ENV];
    if (!key?.trim()) throw new Error("T3 inference credentials are unavailable.");
    return {
      ...options,
      apiKey: key,
      headers: { ...withoutAuthorization(options?.headers), Authorization: "Bearer " + key },
    };
  };
  const streams: ProviderStreams = {
    stream: (model, context, options) => api.stream(checkedModel(model), context, routeOptions(options)),
    streamSimple: (model, context, options) => api.streamSimple(checkedModel(model), context, routeOptions(options)),
  };
  pi.registerProvider(createProvider({
    id: PROVIDER,
    name: "T3 inference",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: "T3 inference",
        resolve: async ({ ctx }) => {
          const key = await ctx.env(KEY_ENV);
          return key?.trim() ? { auth: { apiKey: key }, source: "T3 inference" } : undefined;
        },
      },
    },
    api: streams,
    // /v1/models supplies IDs only; these are Pi's documented defaults, not measured capabilities or prices.
    models: [...ids].map((id) => ({
      id,
      name: id,
      api: "openai-completions" as const,
      provider: PROVIDER,
      baseUrl: config.baseUrl,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    })),
  }));
}
`;
