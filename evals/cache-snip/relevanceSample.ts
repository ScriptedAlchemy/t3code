// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Samples old tool outputs with the message they faced, for scoring on a local model. Writes chat text, so keep the output local.
// usage: node evals/cache-snip/relevanceSample.ts <artifact dir> [rows per split]
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { readClaude, readCodex, type Replay, type TextCapture } from "./replay.ts";
import { sessionKey } from "./simulate.ts";
import { loadApiCalls, type ApiCall } from "./usageRecords.ts";

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: relevanceSample.ts <artifact dir> [rows per split]");
const perSplit = Number(process.argv[3] ?? 300);
const MIN_IDLE_CALLS = 5;
const MIN_TOKENS = 100;
const MAX_ROWS_PER_SESSION = 40;
const POSITIVE_SHARE = 0.4;

interface Row {
  session: string;
  provider: string;
  t: number;
  block: number;
  tokens: number;
  age: number;
  idle: number;
  used: number;
  split: "calibration" | "sealed";
  key: number;
}

const stableKey = (value: string) =>
  NodeCrypto.createHash("sha1").update(value).digest().readUInt32BE(0);

const lines = NodeFS.readFileSync(NodePath.join(dir, "relevance-rows.csv"), "utf8")
  .trim()
  .split("\n");
const names = lines[0]!.split(",");
const column = (name: string) => names.indexOf(name);
const rows: Row[] = lines.slice(1).flatMap((line) => {
  const cells = line.split(",");
  const session = cells[column("session")]!;
  const tokens = Number(cells[column("tokens")]);
  const idle = Number(cells[column("idle")]);
  if (tokens < MIN_TOKENS || idle <= MIN_IDLE_CALLS) return [];
  const t = cells[column("t")]!;
  const block = cells[column("block")]!;
  return [
    {
      session,
      provider: cells[column("provider")]!,
      t: Number(t),
      block: Number(block),
      tokens,
      age: Number(cells[column("age")]),
      idle,
      used: Number(cells[column("used")]),
      // Whole sessions stay on one side, so a model never scores a thread it was tuned on.
      split: stableKey(`split:${session}`) % 10 < 7 ? "calibration" : "sealed",
      key: stableKey(`row:${session}:${t}:${block}`),
    },
  ];
});

function pick(split: Row["split"], used: number, count: number) {
  const held = new Map<string, number>();
  const chosen: Row[] = [];
  for (const row of rows
    .filter((candidate) => candidate.split === split && candidate.used === used)
    .toSorted((a, b) => a.key - b.key)) {
    const taken = held.get(row.session) ?? 0;
    if (taken >= MAX_ROWS_PER_SESSION || chosen.length >= count) continue;
    held.set(row.session, taken + 1);
    chosen.push(row);
  }
  return chosen;
}

const sample = (["calibration", "sealed"] as const).flatMap((split) => [
  ...pick(split, 1, Math.round(perSplit * POSITIVE_SHARE)),
  ...pick(split, 0, Math.round(perSplit * (1 - POSITIVE_SHARE))),
]);

const replays = new Map(
  NodeFS.readdirSync(NodePath.join(dir, "replay")).map((name) => {
    const replay = JSON.parse(
      NodeFS.readFileSync(NodePath.join(dir, "replay", name), "utf8"),
    ) as Replay;
    return [sessionKey(replay.file), replay] as const;
  }),
);
const callsByFile = new Map<string, ApiCall[]>();
for (const call of loadApiCalls(NodePath.join(dir, "usage-scan-cache-v11.json"))) {
  const list = callsByFile.get(call.file) ?? [];
  list.push(call);
  callsByFile.set(call.file, list);
}

const clip = (text: string, head: number, tail = 0) =>
  text.length <= head + tail
    ? text
    : `${text.slice(0, head)}\n[... ${text.length - head - tail} characters omitted ...]\n${tail > 0 ? text.slice(-tail) : ""}`;

const out = NodeFS.createWriteStream(NodePath.join(dir, "relevance-sample.jsonl"));
let written = 0;
let mismatched = 0;
const bySession = new Map<string, Row[]>();
for (const row of sample) {
  const list = bySession.get(row.session) ?? [];
  list.push(row);
  bySession.set(row.session, list);
}
for (const [session, sessionRows] of bySession) {
  const replay = replays.get(session);
  if (replay === undefined) continue;
  const capture: TextCapture = {
    wanted: new Set(sessionRows.map((row) => row.block)),
    outputs: new Map(),
    calls: new Map(),
    users: [],
    answers: [],
  };
  const calls = callsByFile.get(replay.file) ?? [];
  const read = replay.provider === "codex" ? readCodex : readClaude;
  const builder = await read(replay.file, calls, () => 0, capture);
  for (const row of sessionRows) {
    const output = capture.outputs.get(row.block);
    if (output === undefined || builder.blocks[row.block]?.tokens !== row.tokens) {
      mismatched += 1;
      continue;
    }
    const newest = capture.users.filter((user) => user.call <= row.t).slice(-3);
    const newMessage = newest.at(-1)?.text ?? "";
    const answer = capture.answers.filter((item) => item.call < row.t).at(-1)?.text ?? "";
    out.write(
      `${JSON.stringify({
        id: `${session}:${row.t}:${row.block}`,
        split: row.split,
        provider: row.provider,
        used: row.used,
        tokens: row.tokens,
        idle: row.idle,
        age: row.age,
        state: {
          new_user_message: clip(newMessage, 2_000),
          earlier_user_messages: newest.slice(0, -1).map((user) => clip(user.text, 500)),
          latest_assistant_answer: clip(answer, 1_000),
          earlier_tool_call: capture.calls.get(row.block) ?? "",
          earlier_tool_output: clip(output, 6_000, 1_500),
          calls_since_it_was_last_used: row.idle,
        },
      })}\n`,
    );
    written += 1;
  }
}
out.end();
console.log(`sampled ${written}, not found ${mismatched}, sessions ${bySession.size}`);
