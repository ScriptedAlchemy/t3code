// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// What is the prompt made of, weighted by how many times each token is re-read?
// usage: node evals/cache-snip/compose.ts <artifact dir> [days]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Block, Replay } from "./replay.ts";

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: compose.ts <artifact dir> [days]");
const days = Number(process.argv[3] ?? 30);
const GRACE_CALLS = 5;

const replays = NodeFS.readdirSync(NodePath.join(dir, "replay")).map(
  (name) => JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "replay", name), "utf8")) as Replay,
);
const latest = Math.max(...replays.flatMap((replay) => replay.calls.map((call) => call.ts)));
const cutoff = latest - days * 86_400_000;

const ageName = (age: number) =>
  age <= 10 ? "<=10" : age <= 50 ? "11-50" : age <= 200 ? "51-200" : ">200";

for (const provider of ["codex", "claude"]) {
  const tally = new Map<string, number>();
  const bump = (key: string, value: number) => tally.set(key, (tally.get(key) ?? 0) + value);
  let negativeBase = 0;
  let callCount = 0;
  const epochPeaks: number[] = [];
  for (const replay of replays.filter((candidate) => candidate.provider === provider)) {
    let live: Block[] = [];
    const byArrival = new Map<number, Block[]>();
    for (const block of replay.blocks) {
      const list = byArrival.get(block.arrival) ?? [];
      list.push(block);
      byArrival.set(block.arrival, list);
    }
    let peak = 0;
    replay.calls.forEach((call, index) => {
      if (call.reset) {
        if (peak > 0) epochPeaks.push(peak);
        peak = 0;
        live = [];
      }
      peak = Math.max(peak, call.prompt);
      live.push(...(byArrival.get(index) ?? []));
      if (call.ts < cutoff) return;
      callCount += 1;
      let attributed = 0;
      for (const block of live) {
        attributed += block.tokens;
        if (block.kind !== "tool_output") {
          bump(`kind:${block.kind}`, block.tokens);
          continue;
        }
        const age = index - block.arrival;
        bump("kind:tool_output", block.tokens);
        bump(`age:${ageName(age)}`, block.tokens);
        bump(`class:${block.toolClass ?? "none"}`, block.tokens);
        if (block.lastUse + GRACE_CALLS < index) bump("dead:strict", block.tokens);
        if (block.lastUseLoose + GRACE_CALLS < index) bump("dead:loose", block.tokens);
        if (block.supersededAt !== null && block.supersededAt <= index) {
          bump("superseded", block.tokens);
        }
        if (
          (block.supersededAt !== null && block.supersededAt <= index) ||
          (block.rereadAt !== null && block.rereadAt <= index)
        ) {
          bump("superseded+reread", block.tokens);
        }
      }
      if (attributed > call.prompt * 1.02) negativeBase += 1;
      bump("base", Math.max(0, call.prompt - attributed));
      bump("prompt", call.prompt);
    });
    if (peak > 0) epochPeaks.push(peak);
  }
  const prompt = tally.get("prompt") ?? 1;
  const sorted = epochPeaks.toSorted((a, b) => a - b);
  const q = (value: number) => sorted[Math.floor(value * sorted.length)] ?? 0;
  console.log(
    `\n== ${provider}: prompt-weighted composition over ${callCount} calls, ${(prompt / 1e9).toFixed(2)}B prompt tokens`,
  );
  for (const [key, value] of [...tally.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (key === "prompt") continue;
    console.log(`  ${key.padEnd(20)} ${((value / prompt) * 100).toFixed(1).padStart(5)}%`);
  }
  console.log(
    `  calls with attributed > prompt: ${negativeBase}. Epoch peak prompt p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)} (${sorted.length} epochs)`,
  );
}
