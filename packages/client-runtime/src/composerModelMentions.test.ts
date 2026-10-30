import { describe, expect, it } from "vite-plus/test";

import {
  collectComposerModelMentions,
  formatComposerModelMention,
  rankComposerModelMentions,
} from "./composerModelMentions.ts";

const models = [
  { id: "traex:gpt", name: "GPT-6.1", driverKind: "codex", providerDisplayName: "Traex" },
  {
    id: "opencode:traex-gpt",
    name: "GPT-6.1",
    subProvider: "Traex",
    driverKind: "opencode",
    providerDisplayName: "OpenCode",
  },
  {
    id: "opencode:opus",
    name: "Claude Opus 5.5",
    subProvider: "Anthropic",
    driverKind: "opencode",
    providerDisplayName: "OpenCode",
  },
];

function rank(query: string): string[] {
  return rankComposerModelMentions(models, query, (model) => model).map((model) => model.id);
}

describe("rankComposerModelMentions", () => {
  it("names no models for a bare @", () => {
    expect(rank("")).toEqual([]);
  });

  it.each(["-", "---", ":/-/:"])("offers no models for separator-only @%s", (query) => {
    expect(rank(query)).toEqual([]);
  });

  it("finds a model under every provider that serves it", () => {
    expect(rank("gpt").toSorted()).toEqual(["opencode:traex-gpt", "traex:gpt"]);
  });

  it("splits words a mention joins with :, / or -", () => {
    expect(rank("opencode:traex")).toEqual(["opencode:traex-gpt"]);
    expect(rank("opencode/gpt")).toEqual(["opencode:traex-gpt"]);
    expect(rank("opencode-gpt")).toEqual(["opencode:traex-gpt"]);
  });

  it("keeps a hyphenated model name whole when it matches", () => {
    expect(rank("gpt-6.1").toSorted()).toEqual(["opencode:traex-gpt", "traex:gpt"]);
  });

  it("does not fuzzy-match words that only resemble a model", () => {
    expect(rank("src")).toEqual([]);
  });
});

describe("formatComposerModelMention", () => {
  it("names the provider instance and the model", () => {
    expect(formatComposerModelMention("opencode", "anthropic/opus")).toBe(
      "model:opencode/anthropic/opus",
    );
  });
});

describe("collectComposerModelMentions", () => {
  it("reads back what formatComposerModelMention writes, inside prose", () => {
    const text = `use ${formatComposerModelMention("opencode", "anthropic/opus")}, then model:codex/gpt-5.4.`;
    expect(collectComposerModelMentions(text)).toEqual([
      {
        instanceId: "opencode",
        model: "anthropic/opus",
        source: "model:opencode/anthropic/opus",
        start: 4,
        end: 33,
      },
      { instanceId: "codex", model: "gpt-5.4", source: "model:codex/gpt-5.4", start: 40, end: 59 },
    ]);
  });

  it.each(["remodel:codex/gpt", "model:codex", "model:/gpt", "model:codex/.", "model:1x/gpt"])(
    "ignores %s",
    (text) => {
      expect(collectComposerModelMentions(text)).toEqual([]);
    },
  );
});
