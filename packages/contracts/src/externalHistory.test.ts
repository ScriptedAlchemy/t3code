import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  ExternalHistoryRequest,
  ExternalHistoryResponse,
  ExternalHistorySettings,
} from "./externalHistory.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decode = Schema.decodeUnknownSync(ExternalHistoryResponse);
const encode = Schema.encodeSync(ExternalHistoryResponse);
const decodeRequest = Schema.decodeUnknownSync(ExternalHistoryRequest);
const legacySources = Schema.Struct({
  operation: Schema.Literal("sources"),
  enabled: Schema.Boolean,
  sources: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      kind: Schema.Literals(["codex", "local_transcript"]),
    }),
  ),
});

const decodeLegacy = Schema.decodeUnknownSync(legacySources);
const decodeSettings = Schema.decodeUnknownSync(ExternalHistorySettings);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("external history catalogs", () => {
  it("defaults legacy-server capabilities without inferring them from the source kind", () => {
    expect(
      decode({
        operation: "sources",
        enabled: true,
        sources: [{ id: "old", label: "Codex", kind: "codex" }],
      }),
    ).toEqual({
      operation: "sources",
      enabled: true,
      unsupported: [],
      sources: [
        {
          id: "old",
          label: "Codex",
          kind: "codex",
          status: "ready",
          capabilities: { cwdFilter: false, archived: false },
        },
      ],
    });
    expect(decodeRequest({ operation: "sources" })).toEqual({
      operation: "sources",
    });
    expect(decodeRequest({ operation: "sources", catalogVersion: 2 })).toEqual({
      operation: "sources",
      catalogVersion: 2,
    });
  });

  it("round-trips the new catalog while a legacy catalog still decodes with the old source union", () => {
    const response = decode({
      operation: "sources",
      enabled: true,
      sources: [
        {
          id: "claude",
          label: "Claude Code",
          kind: "local_transcript",
          provider: "claudeAgent",
          capabilities: { cwdFilter: true, archived: false },
          status: "ready",
        },
        {
          id: "opencode",
          label: "OpenCode",
          kind: "local_transcript",
          provider: "opencode",
          capabilities: { cwdFilter: true, archived: false },
          status: "unsupported_format",
          message: "Unsupported OpenCode history format.",
        },
        {
          id: "codex",
          label: "Codex",
          kind: "codex",
          capabilities: { cwdFilter: true, archived: true },
          status: "unavailable",
        },
      ],
      unsupported: [{ provider: "grok", label: "Grok", reason: "No verified local reader." }],
    });
    expect(decode(encode(response))).toEqual(response);
    if (response.operation !== "sources") throw new Error("Wrong response");
    expect(
      decodeLegacy({
        ...response,
        sources: response.sources.filter((s) => s.kind !== "local_transcript"),
      }).sources,
    ).toHaveLength(1);
  });

  it("ignores the removed chatGptExportPaths key in stored settings and old-client patches", () => {
    const old = { enabled: true, chatGptExportPaths: ["/exports/conversations.json"] };
    expect(decodeSettings(old)).toEqual({ enabled: true });
    expect(decodeServerSettings({ externalHistory: old }).externalHistory).toEqual({
      enabled: true,
    });
    expect(decodePatch({ externalHistory: old })).toEqual({
      externalHistory: { enabled: true },
    });
  });
});
