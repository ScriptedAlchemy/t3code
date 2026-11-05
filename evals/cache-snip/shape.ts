// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// How prompts behave over a session: size, cold misses, and what list price really is above the long-context cliff.
// usage: node evals/cache-snip/shape.ts <artifact dir> [days]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { lookupRate } from "../../apps/server/src/usage/usagePricing.ts";
import { loadApiCalls, loadRates, price, promptTokens, type ApiCall } from "./usageRecords.ts";

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: shape.ts <artifact dir> [days]");
const days = Number(process.argv[3] ?? 30);
const rates = loadRates(NodePath.join(dir, "usage-model-rates.json"));
const document = (
  JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "usage-model-rates.json"), "utf8")) as {
    document: Record<string, Record<string, number>>;
  }
).document;
const all = loadApiCalls(NodePath.join(dir, "usage-scan-cache-v11.json"));
const latest = Math.max(...all.map((call) => call.timestampMs));
const calls = all.filter((call) => call.timestampMs >= latest - days * 86_400_000);

const LONG_CONTEXT_LIMIT = 272_000;

/** List price including the long-context tier T3's table leaves out, per OpenAI's pricing page. */
function listUsd(call: ApiCall): { billed: number; t3: number } {
  const t3 = price(rates, call).costUsd;
  const entry = document[call.model];
  const long =
    entry !== undefined &&
    promptTokens(call) > LONG_CONTEXT_LIMIT &&
    entry["input_cost_per_token_above_272k_tokens"] !== undefined;
  if (!long) return { billed: t3, t3 };
  const rate = lookupRate(rates, call.model);
  if (rate === null) return { billed: t3, t3 };
  const input = entry["input_cost_per_token_above_272k_tokens"] ?? rate.inputCostPerToken;
  const read = entry["cache_read_input_token_cost_above_272k_tokens"] ?? rate.cacheReadCostPerToken;
  const output = entry["output_cost_per_token_above_272k_tokens"] ?? rate.outputCostPerToken;
  return {
    billed: call.uncached * input + call.cacheRead * read + call.output * output,
    t3,
  };
}

const bucketEdges = [50_000, 100_000, 150_000, 200_000, 272_000, 400_000, 600_000, Infinity];
const bucketName = (edge: number) => (edge === Infinity ? ">600k" : `<=${edge / 1000}k`);

for (const provider of ["codex", "claude"]) {
  const subset = calls.filter((call) => call.provider === provider);
  const rows = bucketEdges.map(() => ({ calls: 0, t3: 0, billed: 0, read: 0 }));
  for (const call of subset) {
    const index = bucketEdges.findIndex((edge) => promptTokens(call) <= edge);
    const row = rows[index]!;
    const { billed, t3 } = listUsd(call);
    row.calls += 1;
    row.t3 += t3;
    row.billed += billed;
    row.read += price(rates, call).categoryCostUsd?.cacheRead ?? 0;
  }
  const t3Total = rows.reduce((sum, row) => sum + row.t3, 0);
  const billedTotal = rows.reduce((sum, row) => sum + row.billed, 0);
  console.log(`\n== ${provider}, last ${days} days, by prompt size`);
  console.log("bucket      calls   T3$    list$  %ofT3$  read$");
  rows.forEach((row, index) => {
    console.log(
      `${bucketName(bucketEdges[index]!).padEnd(9)} ${String(row.calls).padStart(6)} ${row.t3.toFixed(0).padStart(6)} ${row.billed.toFixed(0).padStart(7)} ${((row.t3 / Math.max(t3Total, 1e-9)) * 100).toFixed(1).padStart(6)}% ${row.read.toFixed(0).padStart(6)}`,
    );
  });
  console.log(
    `T3 estimate $${t3Total.toFixed(0)}, with long-context tier $${billedTotal.toFixed(0)} (+${(((billedTotal - t3Total) / t3Total) * 100).toFixed(1)}%)`,
  );
}

interface Session {
  readonly key: string;
  readonly provider: string;
  readonly calls: readonly ApiCall[];
}
const sessionMap = new Map<string, ApiCall[]>();
for (const call of calls) {
  const list = sessionMap.get(call.file) ?? [];
  list.push(call);
  sessionMap.set(call.file, list);
}
const sessions: Session[] = [...sessionMap.entries()].map(([key, list]) => ({
  key,
  provider: list[0]!.provider,
  calls: list.toSorted((a, b) => a.timestampMs - b.timestampMs),
}));

const COLD_MIN_PROMPT = 10_000;
const COLD_READ_SHARE = 0.5;
const quantile = (values: readonly number[], q: number) => {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

for (const provider of ["codex", "claude"]) {
  const subset = sessions.filter((session) => session.provider === provider);
  let cold = 0;
  let total = 0;
  let coldTokens = 0;
  let coldAfterGap = 0;
  let drops = 0;
  const gapsBeforeCold: number[] = [];
  const coldPrompts: number[] = [];
  const gapBuckets = { "<5m": 0, "5-30m": 0, "30-60m": 0, ">60m": 0 };
  const allGaps = { "<5m": 0, "5-30m": 0, "30-60m": 0, ">60m": 0 };
  const key = (minutes: number) =>
    minutes < 5 ? "<5m" : minutes < 30 ? "5-30m" : minutes < 60 ? "30-60m" : ">60m";
  for (const session of subset) {
    session.calls.forEach((call, index) => {
      total += 1;
      const prompt = promptTokens(call);
      const previous = session.calls[index - 1];
      const gapMinutes =
        previous === undefined ? 0 : (call.timestampMs - previous.timestampMs) / 60_000;
      if (previous !== undefined) allGaps[key(gapMinutes)] += 1;
      if (previous !== undefined && prompt < promptTokens(previous) * 0.6) drops += 1;
      if (previous === undefined) return;
      if (prompt >= COLD_MIN_PROMPT && call.cacheRead / prompt < COLD_READ_SHARE) {
        cold += 1;
        coldTokens += call.uncached + call.cacheWrite;
        gapsBeforeCold.push(gapMinutes);
        coldPrompts.push(prompt);
        gapBuckets[key(gapMinutes)] += 1;
        if (gapMinutes >= 5) coldAfterGap += 1;
      }
    });
  }
  const callCounts = subset.map((session) => session.calls.length);
  const usdBySession = subset
    .map((session) => session.calls.reduce((sum, call) => sum + price(rates, call).costUsd, 0))
    .toSorted((a, b) => b - a);
  const usdTotal = usdBySession.reduce((sum, value) => sum + value, 0);
  const top = (n: number) =>
    usdBySession.slice(0, n).reduce((sum, value) => sum + value, 0) / Math.max(usdTotal, 1e-9);
  console.log(`\n== ${provider}, session shape`);
  console.log(
    `sessions ${subset.length}, calls ${total}, calls/session p50 ${quantile(callCounts, 0.5)} p90 ${quantile(callCounts, 0.9)} max ${Math.max(0, ...callCounts)}`,
  );
  console.log(
    `$ concentration: top 10 sessions ${(top(10) * 100).toFixed(0)}%, top 20 ${(top(20) * 100).toFixed(0)}%, top 50 ${(top(50) * 100).toFixed(0)}%`,
  );
  console.log(
    `cold calls ${cold} (${((cold / Math.max(total, 1)) * 100).toFixed(2)}%), uncached+write tokens in them ${(coldTokens / 1e6).toFixed(1)}M, prompt p50 ${quantile(coldPrompts, 0.5)} p90 ${quantile(coldPrompts, 0.9)}`,
  );
  console.log("gap before cold calls:", gapBuckets, " all gaps:", allGaps);
  console.log(`prompt drops over 40% (compaction or reset): ${drops}`);
}
