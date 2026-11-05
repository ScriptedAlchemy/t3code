// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Samples old tool outputs with the message they faced, to score and fine-tune local models. Writes chat text, so keep the output local.
// usage: node evals/cache-snip/relevanceSample.ts <artifact dir> [rows per split]
// Writes relevance-sample.jsonl and relevance-compact.jsonl to score, and relevance-fit-{train,dev}.jsonl to fine-tune.
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
const FIT_SESSION_CAP = { used: 400, unused: 600 };
const FIT_TOTALS = {
  train: { used: 4_000, unused: 6_000 },
  dev: { used: 800, unused: 800 },
};
const questions = JSON.parse(
  NodeFS.readFileSync(new URL("./relevanceQuestions.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

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

function pickFrom(pool: readonly Row[], used: number, count: number, sessionCap: number) {
  const held = new Map<string, number>();
  const chosen: Row[] = [];
  for (const row of pool
    .filter((candidate) => candidate.used === used)
    .toSorted((a, b) => a.key - b.key)) {
    const taken = held.get(row.session) ?? 0;
    if (taken >= sessionCap || chosen.length >= count) continue;
    held.set(row.session, taken + 1);
    chosen.push(row);
  }
  return chosen;
}

const pick = (split: Row["split"], used: number, count: number) =>
  pickFrom(
    rows.filter((row) => row.split === split),
    used,
    count,
    MAX_ROWS_PER_SESSION,
  );

const sample = (["calibration", "sealed"] as const).flatMap((split) => [
  ...pick(split, 1, Math.round(perSplit * POSITIVE_SHARE)),
  ...pick(split, 0, Math.round(perSplit * (1 - POSITIVE_SHARE))),
]);

const sampled = new Set(sample.map((row) => `${row.session}:${row.t}:${row.block}`));
// Early stopping uses whole sessions of its own, so it cannot flatter a model on threads it trained on.
const tuning = rows.filter(
  (row) => row.split === "calibration" && !sampled.has(`${row.session}:${row.t}:${row.block}`),
);
const isDev = (row: Row) => stableKey(`dev:${row.session}`) % 5 === 0;
const fitRows = (part: keyof typeof FIT_TOTALS) => {
  const pool = tuning.filter((row) => (part === "dev") === isDev(row));
  return [
    ...pickFrom(pool, 1, FIT_TOTALS[part].used, FIT_SESSION_CAP.used),
    ...pickFrom(pool, 0, FIT_TOTALS[part].unused, FIT_SESSION_CAP.unused),
  ];
};
const fit = { train: fitRows("train"), dev: fitRows("dev") };

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

// Small encoders see about 1,000 tokens, and truncation cuts from the end, so the output goes last.
const compactState = (input: {
  newMessage: string;
  earlier: readonly string[];
  answer: string;
  call: string;
  output: string;
  idle: number;
}) =>
  [
    `New message: ${clip(input.newMessage, 700)}`,
    ...input.earlier.map((text) => `Earlier message: ${clip(text, 150)}`),
    `Latest answer: ${clip(input.answer, 300)}`,
    `Tool call: ${clip(input.call, 200)}`,
    `Calls since last used: ${input.idle}`,
    `Tool output: ${clip(input.output, 1_800, 400)}`,
  ].join("\n");

const open = (name: string) => NodeFS.createWriteStream(NodePath.join(dir, name));
const out = open("relevance-sample.jsonl");
const compactOut = open("relevance-compact.jsonl");
const fitOut = { train: open("relevance-fit-train.jsonl"), dev: open("relevance-fit-dev.jsonl") };
let written = 0;
let mismatched = 0;
type Planned = Row & { part: "sample" | "train" | "dev" };
const bySession = new Map<string, Planned[]>();
const plan = (part: Planned["part"], list: readonly Row[]) => {
  for (const row of list) {
    const held = bySession.get(row.session) ?? [];
    held.push({ ...row, part });
    bySession.set(row.session, held);
  }
};
plan("sample", sample);
plan("train", fit.train);
plan("dev", fit.dev);
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
    const earlier = newest.slice(0, -1).map((user) => user.text);
    const answer = capture.answers.filter((item) => item.call < row.t).at(-1)?.text ?? "";
    const call = capture.calls.get(row.block) ?? "";
    const id = `${session}:${row.t}:${row.block}`;
    const compact = compactState({ newMessage, earlier, answer, call, output, idle: row.idle });
    if (row.part === "sample") {
      const base = {
        id,
        split: row.split,
        provider: row.provider,
        used: row.used,
        tokens: row.tokens,
        idle: row.idle,
        age: row.age,
      };
      out.write(
        `${JSON.stringify({
          ...base,
          state: {
            new_user_message: clip(newMessage, 2_000),
            earlier_user_messages: earlier.map((text) => clip(text, 500)),
            latest_assistant_answer: clip(answer, 1_000),
            earlier_tool_call: call,
            earlier_tool_output: clip(output, 6_000, 1_500),
            calls_since_it_was_last_used: row.idle,
          },
        })}\n`,
      );
      compactOut.write(`${JSON.stringify({ ...base, state: compact })}\n`);
    } else {
      fitOut[row.part].write(
        `${JSON.stringify({
          id,
          state: compact,
          questions: { needed: questions["needed"] },
          labels: { needed: row.used === 1 },
        })}\n`,
      );
    }
    written += 1;
  }
}
for (const stream of [out, compactOut, fitOut.train, fitOut.dev]) stream.end();
console.log(
  `written ${written}, not found ${mismatched}, sessions ${bySession.size}, train ${fit.train.length}, dev ${fit.dev.length}`,
);
