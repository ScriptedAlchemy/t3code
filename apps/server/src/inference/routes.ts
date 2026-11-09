import {
  ProviderDriverKind,
  type CustomModelSetting,
  type InferenceDriver,
} from "@t3tools/contracts";

const PREFIX = "/api/inference";

export function inferencePath(method: string, rawUrl: string): string | null {
  if (!rawUrl.startsWith(PREFIX)) return null;
  const path = rawUrl.slice(PREFIX.length);
  if (method === "GET" && path === "/v1/models") return path;
  if (method !== "POST") return null;
  return [
    "/v1/responses",
    "/v1/responses/compact",
    "/v1/messages",
    "/v1/messages/count_tokens",
    "/v1/messages?beta=true",
    "/v1/messages/count_tokens?beta=true",
  ].includes(path)
    ? path
    : null;
}

export function validateRouteUrl(value: string, local: boolean): boolean {
  const url = URL.parse(value);
  if (!url || url.origin + (local ? "" : PREFIX) !== value) return false;
  return local
    ? url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== ""
    : (url.protocol === "https:" && /^[a-z0-9.-]+\.ts\.net$/u.test(url.hostname)) ||
        (url.protocol === "http:" &&
          /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) &&
          /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname));
}

export function routeProvider(
  driver: InferenceDriver,
  baseUrl: string,
  key: string,
  label: string,
  models: readonly string[],
  homePath: string,
) {
  const codex = driver === "codex";
  const provider = `model_providers.t3proxy={name="T3 inference",base_url="${baseUrl}/v1",env_key="T3_INFERENCE_KEY",wire_api="responses",supports_websockets=false,requires_openai_auth=false}`;
  return {
    driver: ProviderDriverKind.make(driver),
    displayName: `${codex ? "Codex" : "Claude"} via ${label}`,
    enabled: true,
    config: {
      setupMode: "inference",
      customModels: models,
      homePath,
      ...(codex ? { launchArgs: `-c 'model_provider="t3proxy"' -c '${provider}'` } : {}),
    },
    environment: codex
      ? [
          { name: "T3_INFERENCE_KEY", value: key, sensitive: true },
          { name: "T3CODE_CODEX_LAUNCH_ARGS", value: "", sensitive: false },
        ]
      : [
          { name: "ANTHROPIC_BASE_URL", value: baseUrl, sensitive: false },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "", sensitive: false },
          { name: "ANTHROPIC_AUTH_TOKEN", value: key, sensitive: true },
        ],
  };
}

export function inferenceModelSlugs(config: {
  setupMode?: string;
  customModels: readonly CustomModelSetting[];
}) {
  return config.setupMode === "inference"
    ? new Set(config.customModels.map((entry) => (typeof entry === "string" ? entry : entry.slug)))
    : null;
}
