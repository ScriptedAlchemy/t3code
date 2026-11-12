import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { activePiBranch, TranscriptRecord, transcriptItems } from "./agentTranscripts.ts";

const decode = Schema.decodeUnknownSync(TranscriptRecord);

describe("transcript evidence", () => {
  it("keeps native Claude identities and tool evidence without thinking or hidden records", () => {
    const record = decode({
      uuid: "native-uuid",
      type: "assistant",
      message: {
        content: [
          { type: "thinking", text: "private reasoning" },
          { type: "text", text: "Visible answer" },
          { type: "tool_use", name: "read", input: { path: "src/index.ts" } },
          { type: "tool_result", content: [{ type: "text", text: "File contents" }] },
        ],
      },
    });
    expect(transcriptItems(record, "claudeAgent")).toEqual([
      { id: "native-uuid", role: "assistant", text: "Visible answer" },
      { id: "native-uuid/tool/2", role: "tool", text: 'read\n{"path":"src/index.ts"}' },
      { id: "native-uuid/tool/3", role: "tool", text: "File contents" },
    ]);
    for (const flag of ["isSidechain", "isMeta", "isCompactSummary"])
      expect(transcriptItems(decode({ ...record, [flag]: true }), "claudeAgent")).toEqual([]);
  });

  it("keeps only the active Pi lineage with its original entry IDs", () => {
    const records = [
      { type: "session", id: "session" },
      {
        type: "message",
        id: "first",
        parentId: null,
        message: { role: "user", content: "Question" },
      },
      {
        type: "message",
        id: "abandoned",
        parentId: "first",
        message: { role: "assistant", content: "Old answer" },
      },
      {
        type: "message",
        id: "active",
        parentId: "first",
        message: { role: "assistant", content: "New answer" },
      },
    ].map((record) => decode(record));
    expect(activePiBranch(records).flatMap((r) => transcriptItems(r, "pi"))).toEqual([
      { id: "first", role: "user", text: "Question" },
      { id: "active", role: "assistant", text: "New answer" },
    ]);
  });
});
