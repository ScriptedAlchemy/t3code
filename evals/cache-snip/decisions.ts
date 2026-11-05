// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// One row per moment a compaction could fire: what was knowable then, and what compacting there really saved.
// usage: node evals/cache-snip/decisions.ts <artifact dir> [days] > decisions.csv
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import type { Block, Replay } from "./replay.ts";
import { LONG_LIMIT, makeRateLookup, runEpoch, splitEpochs, type RateMode } from "./simulate.ts";

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: decisions.ts <artifact dir> [days]");
const days = Number(process.argv[3] ?? 30);
const MIN_PROMPT = 50_000;
const REFETCH_RATES = [1, 0.3, 0.1];

const replays = NodeFS.readdirSync(NodePath.join(dir, "replay")).map(
  (name) => JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "replay", name), "utf8")) as Replay,
);
const latest = Math.max(...replays.flatMap((replay) => replay.calls.map((call) => call.ts)));
const cutoff = latest - days * 86_400_000;
const mode = (process.env["CACHE_SNIP_RATES"] ?? "trueList") as RateMode;
const ratesFor = makeRateLookup(dir, mode);

const header = [
  "session",
  "provider",
  "epoch",
  "t",
  "ts",
  "prompt",
  "offset",
  "sessionCalls",
  "userTurns",
  "callsPerTurn",
  "gapMinutes",
  "isCold",
  "isUserTurn",
  "prevReadShare",
  "missOverRead",
  "readUsdPerCall",
  "longTier",
  "growthPerCall",
  "toolShare",
  "idle10Share",
  "idle30Share",
  "priorTurnShare",
  "callsThisTurn",
  "userEstimate",
  "textKey",
  ...REFETCH_RATES.map((rate) => `net${rate}`),
];
const rows: string[] = [header.join(",")];
const hash = (value: string) =>
  NodeCrypto.createHash("sha1").update(value).digest("hex").slice(0, 12);

for (const replay of replays) {
  const session = hash(replay.file);
  let sessionCalls = 0;
  let userTurns = 0;
  splitEpochs(replay, ratesFor).forEach((epoch, epochIndex) => {
    const byArrival = new Map<number, Block[]>();
    for (const block of epoch.blocks) {
      const list = byArrival.get(block.arrival) ?? [];
      list.push(block);
      byArrival.set(block.arrival, list);
    }
    const never = () => [];
    const baseline = REFETCH_RATES.map(
      (refetchRate) => runEpoch(epoch, never, cutoff, { refetchRate }).usd,
    );
    const live: Block[] = [];
    let lastUserCall = epoch.firstIndex;
    epoch.calls.forEach((call, offset) => {
      const t = epoch.firstIndex + offset;
      const arriving = byArrival.get(t) ?? [];
      live.push(...arriving);
      sessionCalls += 1;
      const userBlocks = arriving.filter((block) => block.kind === "user");
      const isUserTurn = epoch.turnStarts.has(t);
      if (isUserTurn) userTurns += 1;
      const callsThisTurn = t - lastUserCall;
      if (isUserTurn) lastUserCall = t;
      const previous = epoch.calls[offset - 1];
      const gapMinutes = previous === undefined ? 0 : (call.ts - previous.ts) / 60_000;
      const isCold = gapMinutes >= 60;
      if (offset === 0 || call.prompt < MIN_PROMPT || call.ts < cutoff) return;
      if (!isUserTurn && !isCold) return;

      let lastUser = -1;
      for (const block of live) {
        if (block.kind === "user" && block.arrival < t)
          lastUser = Math.max(lastUser, block.arrival);
      }
      let tool = 0;
      let idle10 = 0;
      let idle30 = 0;
      let prior = 0;
      for (const block of live) {
        if (block.kind !== "tool_output") continue;
        tool += block.tokens;
        let last = block.arrival;
        for (const use of block.uses) {
          if (use >= t) break;
          last = use;
        }
        if (t - last > 10) idle10 += block.tokens;
        if (t - last > 30) idle30 += block.tokens;
        if (block.arrival < lastUser) prior += block.tokens;
      }
      const rates = epoch.rates[offset]!;
      const net = REFETCH_RATES.map(
        (refetchRate, index) =>
          baseline[index]! -
          runEpoch(epoch, never, cutoff, { refetchRate, compactCalls: new Set([t]) }).usd,
      );
      const longTier = rates.longInput !== null && call.prompt > LONG_LIMIT;
      rows.push(
        [
          session,
          replay.provider,
          epochIndex,
          t,
          call.ts,
          call.prompt,
          offset,
          sessionCalls,
          userTurns,
          (sessionCalls / Math.max(1, userTurns)).toFixed(2),
          gapMinutes.toFixed(2),
          isCold ? 1 : 0,
          isUserTurn ? 1 : 0,
          previous === undefined ? 0 : (previous.read / Math.max(1, previous.prompt)).toFixed(3),
          (rates.miss / Math.max(rates.read, 1e-12)).toFixed(1),
          (call.prompt * rates.read * (longTier ? rates.longInput! : 1)).toFixed(5),
          longTier ? 1 : 0,
          ((call.prompt - epoch.calls[0]!.prompt) / offset).toFixed(1),
          (tool / call.prompt).toFixed(3),
          (idle10 / call.prompt).toFixed(3),
          (idle30 / call.prompt).toFixed(3),
          (prior / call.prompt).toFixed(3),
          callsThisTurn,
          userBlocks.reduce((sum, block) => sum + block.estimate, 0).toFixed(0),
          userBlocks[0]?.textKey ?? "",
          ...net.map((value) => value.toFixed(5)),
        ].join(","),
      );
    });
  });
}
NodeFS.writeFileSync(
  NodePath.join(dir, mode === "trueList" ? "decisions.csv" : `decisions-${mode}.csv`),
  `${rows.join("\n")}\n`,
);
console.log(`candidates ${rows.length - 1}`);
