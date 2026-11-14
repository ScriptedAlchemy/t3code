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

  it("round-trips discovered native histories with source capabilities and status", () => {
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
