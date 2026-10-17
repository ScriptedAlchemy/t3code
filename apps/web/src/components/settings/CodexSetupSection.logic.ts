export function readCodexSetupMode(config: unknown): "managed" | "existing" | "cli" {
  if (config !== null && typeof config === "object" && "setupMode" in config) {
    if (config.setupMode === "managed" || config.setupMode === "cli") return config.setupMode;
  }
  return "existing";
}
