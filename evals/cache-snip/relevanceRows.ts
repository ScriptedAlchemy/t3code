// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// One row per tool output at each moment a head cut could fire: what was knowable then, and whether it was used later.
// usage: node evals/cache-snip/relevanceRows.ts <artifact dir> [days]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Block, Replay } from "./replay.ts";
import { makeRateLookup, sessionKey, splitEpochs } from "./simulate.ts";

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: relevanceRows.ts <artifact dir> [days]");
const days = Number(process.argv[3] ?? 30);
const MIN_PROMPT = 100_000;
const MIN_BLOCK_TOKENS = 50;
const CLASSES = ["read", "search", "shell", "edit", "mcp", "agent", "other"];

const replays = NodeFS.readdirSync(NodePath.join(dir, "replay")).map(
  (name) => JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "replay", name), "utf8")) as Replay,
);
const latest = Math.max(...replays.flatMap((replay) => replay.calls.map((call) => call.ts)));
const cutoff = latest - days * 86_400_000;
const ratesFor = makeRateLookup(dir, "trueList");

const out = NodeFS.createWriteStream(NodePath.join(dir, "relevance-rows.csv"));
out.write(
  "session,provider,t,ts,block,tokens,age,idle,usesSoFar,turnsSinceArrival,turnsSinceUse,namedNow,namedBefore,reread,superseded,toolClass,prompt,isCold,used,usedLoose\n",
);
let rows = 0;
let moments = 0;
for (const replay of replays) {
  const session = sessionKey(replay.file);
  const turnStarts = [...new Set(replay.turnStarts)].toSorted((a, b) => a - b);
  for (const epoch of splitEpochs(replay, ratesFor)) {
    const live: Block[] = [];
    const byArrival = new Map<number, Block[]>();
    for (const block of epoch.blocks) {
      const list = byArrival.get(block.arrival) ?? [];
      list.push(block);
      byArrival.set(block.arrival, list);
    }
    epoch.calls.forEach((call, offset) => {
      const t = epoch.firstIndex + offset;
      live.push(...(byArrival.get(t) ?? []));
      const previous = epoch.calls[offset - 1];
      const isCold = previous !== undefined && (call.ts - previous.ts) / 60_000 >= 60;
      if (call.ts < cutoff || call.prompt < MIN_PROMPT || offset === 0) return;
      if (!epoch.turnStarts.has(t) && !isCold) return;
      moments += 1;
      const turnsBefore = (index: number) =>
        turnStarts.filter((start) => start > index && start <= t).length;
      for (const block of live) {
        if (block.kind !== "tool_output" || block.tokens < MIN_BLOCK_TOKENS || block.arrival >= t)
          continue;
        let last = block.arrival;
        let usesSoFar = 0;
        for (const use of block.uses) {
          if (use >= t) break;
          last = use;
          usesSoFar += 1;
        }
        const used = block.uses.some((use) => use >= t) ? 1 : 0;
        const usedLoose = block.lastUseLoose >= t ? 1 : 0;
        out.write(
          `${session},${replay.provider},${t},${call.ts},${block.id},${block.tokens},${t - block.arrival},${t - last},${usesSoFar},${turnsBefore(block.arrival)},${turnsBefore(last)},${block.mentions.includes(t) ? 1 : 0},${block.mentions.some((at) => at < t) ? 1 : 0},${block.rereadAt !== null && block.rereadAt <= t ? 1 : 0},${block.supersededAt !== null && block.supersededAt <= t ? 1 : 0},${CLASSES.indexOf(block.toolClass ?? "other")},${call.prompt},${isCold ? 1 : 0},${used},${usedLoose}\n`,
        );
        rows += 1;
      }
    });
  }
}
out.end();
console.log(
  `rows ${rows}, moments ${moments}, tool outputs per moment ${(rows / Math.max(moments, 1)).toFixed(0)}`,
);
