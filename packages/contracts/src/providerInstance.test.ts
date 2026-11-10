import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  currentProviderInstanceId,
  ProviderInstanceEnvironmentVariable,
  ProviderInstanceId,
} from "./providerInstance.ts";

const decodeEnvironmentVariable = Schema.decodeUnknownSync(ProviderInstanceEnvironmentVariable);

describe("ProviderInstanceEnvironmentVariable", () => {
  it("treats a stored reference as sensitive even when the flag is missing or false", () => {
    const secret = { provider: "onepassword", reference: "op://Private/item/field" };
    expect(decodeEnvironmentVariable({ name: "API_KEY", secret })).toMatchObject({
      value: secret,
      sensitive: true,
    });
    expect(decodeEnvironmentVariable({ name: "API_KEY", sensitive: false, secret }).sensitive).toBe(
      true,
    );
  });
});

describe("currentProviderInstanceId", () => {
  const registered = ["codex", "claudeAgent", "codex_work"].map((id) =>
    ProviderInstanceId.make(id),
  );
  it.each([
    ["inference_codex_1ce3f6740fb26811", "codex"],
    ["inference_claudeAgent_1ce3f6740fb26811", "claudeAgent"],
    ["pool_codex", "codex"],
    ["pool_claudeAgent", "claudeAgent"],
    // Not a retired shape, or no registered replacement.
    ["codex_work", "codex_work"],
    ["inference_codex_host", "inference_codex_host"],
    ["pool_cursor", "pool_cursor"],
  ])("maps %s to %s", (saved, current) => {
    expect(currentProviderInstanceId(ProviderInstanceId.make(saved), registered)).toBe(current);
  });

  it("keeps a retired-shaped id that is still registered", () => {
    const legacy = ProviderInstanceId.make("inference_codex_1ce3f6740fb26811");
    expect(currentProviderInstanceId(legacy, [...registered, legacy])).toBe(legacy);
  });
});
