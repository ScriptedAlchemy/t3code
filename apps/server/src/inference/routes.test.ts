import { describe, expect, it } from "@effect/vitest";
import { inferencePath, routeProvider, validateRouteUrl } from "./routes.ts";

describe("inference routes", () => {
  it("forwards only the protocol endpoints at the mounted path", () => {
    expect(inferencePath("POST", "/api/inference/v1/messages?beta=true")).toBe(
      "/v1/messages?beta=true",
    );
    expect(inferencePath("GET", "/api/inference/v1/models")).toBe("/v1/models");
    for (const path of [
      "/v0/management/auth-files",
      "/v1/messages/../models",
      "//somewhere.example",
      "/v1/responses?key=secret",
    ]) {
      expect(inferencePath("POST", "/api/inference" + path)).toBeNull();
    }
    expect(inferencePath("GET", "/api/inference/v1/messages")).toBeNull();
  });

  it("accepts private LAN addresses and HTTPS tailnet routes and confines local keys to loopback", () => {
    expect(validateRouteUrl("https://pool.example.ts.net:9443/api/inference", false)).toBe(true);
    expect(validateRouteUrl("http://127.0.0.1:18001", true)).toBe(true);
    expect(validateRouteUrl("http://192.168.20.4:3773/api/inference", false)).toBe(true);
    for (const url of [
      "http://127.0.0.1:3000/api/inference",
      "http://169.254.169.254/api/inference",
      "http://8.8.8.8/api/inference",
      "http://127.0.0.1:18001",
      "http://office.ts.net/api/inference",
      "https://office.ts.net.attacker.com/api/inference",
      "https://x@office.ts.net/api/inference",
      "https://office.ts.net/api/inference?x=1",
    ]) {
      expect(validateRouteUrl(url, false)).toBe(false);
    }
  });

  it("keeps proxy credentials out of Codex launch arguments and marks both drivers' keys sensitive", () => {
    const url = "https://office.example.ts.net/api/inference";
    const codex = routeProvider("codex", url, "private", "Office", ["gpt-fixture"], "/state/codex");
    const claude = routeProvider(
      "claudeAgent",
      url,
      "private",
      "Office",
      ["claude-fixture"],
      "/state/claude",
    );
    expect(codex.config.launchArgs).toContain(url + "/v1");
    expect(codex.config.launchArgs).not.toContain("private");
    expect(codex.environment).toContainEqual({
      name: "T3_INFERENCE_KEY",
      value: "private",
      sensitive: true,
    });
    expect(claude.environment).toContainEqual({
      name: "ANTHROPIC_AUTH_TOKEN",
      value: "private",
      sensitive: true,
    });
  });
});
