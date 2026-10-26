import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchComposerModelItems } from "./composerModelMentions";
import type { ModelEsque } from "./providerIconUtils";

const traex = {
  instanceId: ProviderInstanceId.make("traex"),
  driverKind: ProviderDriverKind.make("codex"),
  displayName: "Traex",
  acpRegistryAgentId: undefined,
  acpRegistryIconUrl: undefined,
  continuationGroupKey: undefined,
  enabled: true,
  isAvailable: true,
  status: "ready" as const,
};
const opencode = {
  ...traex,
  instanceId: ProviderInstanceId.make("opencode"),
  driverKind: ProviderDriverKind.make("opencode"),
  displayName: "OpenCode",
};
const claude = {
  ...traex,
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driverKind: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
};

const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>([
  [traex.instanceId, [{ slug: "gpt-6.1", name: "GPT-6.1" }]],
  [
    opencode.instanceId,
    [
      { slug: "traex/gpt-6.1", name: "GPT-6.1", subProvider: "Traex" },
      { slug: "anthropic/opus", name: "Claude Opus 5.5", subProvider: "Anthropic" },
    ],
  ],
  [claude.instanceId, [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5" }]],
]);

function match(
  query: string,
  overrides: Partial<Parameters<typeof matchComposerModelItems>[0]> = {},
): string[] {
  return matchComposerModelItems({
    instanceEntries: [traex, opencode, claude],
    modelOptionsByInstance,
    lockedProvider: null,
    lockedContinuationGroupKey: null,
    isModelDisabled: () => false,
    query,
    ...overrides,
  }).map((item) => `${item.instanceId}:${item.model}`);
}

describe("matchComposerModelItems", () => {
  it("offers nothing for a bare @ so files and threads keep the menu", () => {
    expect(match("")).toEqual([]);
  });

  it("finds a model under every provider that serves it", () => {
    expect(match("gpt").toSorted()).toEqual(["opencode:traex/gpt-6.1", "traex:gpt-6.1"]);
  });

  it("narrows by provider and sub-provider words joined without spaces", () => {
    expect(match("opencode:traex")).toEqual(["opencode:traex/gpt-6.1"]);
    expect(match("opencode-gpt")).toEqual(["opencode:traex/gpt-6.1"]);
  });

  it("does not fuzzy-match words that only resemble a model", () => {
    expect(match("src")).toEqual([]);
  });

  it("leaves out providers a started thread can't switch to and disabled models", () => {
    expect(match("opus", { lockedProvider: claude.driverKind })).toEqual([
      "claudeAgent:claude-opus-5-5",
    ]);
    expect(
      match("opus", { isModelDisabled: (instanceId) => instanceId === claude.instanceId }),
    ).toEqual(["opencode:anthropic/opus"]);
  });

  it("leaves out providers that are not ready", () => {
    expect(
      match("gpt", { instanceEntries: [{ ...traex, status: "error" as const }, opencode] }),
    ).toEqual(["opencode:traex/gpt-6.1"]);
  });
});
