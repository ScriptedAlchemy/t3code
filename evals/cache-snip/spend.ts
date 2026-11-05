// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
// Prices every API call in a copy of T3's usage scan cache with T3's own pricing code.
// usage: node evals/cache-snip/spend.ts <dir holding usage-scan-cache-v11.json and usage-model-rates.json>
import * as NodePath from "node:path";

import { loadApiCalls, loadRates, price, type ApiCall } from "./usageRecords.ts";

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: spend.ts <artifact dir>");
const calls = loadApiCalls(NodePath.join(dir, "usage-scan-cache-v11.json"));
const rates = loadRates(NodePath.join(dir, "usage-model-rates.json"));

interface Row {
  calls: number;
  usd: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  unsplitUsd: number;
  tUncached: number;
  tRead: number;
  tWrite: number;
  tOutput: number;
}
const emptyRow = (): Row => ({
  calls: 0,
  usd: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  unsplitUsd: 0,
  tUncached: 0,
  tRead: 0,
  tWrite: 0,
  tOutput: 0,
});

function tally(rows: Map<string, Row>, key: string, call: ApiCall) {
  const row = rows.get(key) ?? emptyRow();
  const priced = price(rates, call);
  row.calls += 1;
  row.usd += priced.costUsd;
  if (priced.categoryCostUsd === null) row.unsplitUsd += priced.costUsd;
  else {
    row.input += priced.categoryCostUsd.input;
    row.cacheRead += priced.categoryCostUsd.cacheRead;
    row.cacheWrite += priced.categoryCostUsd.cacheWrite;
    row.output += priced.categoryCostUsd.output;
  }
  row.tUncached += call.uncached;
  row.tRead += call.cacheRead;
  row.tWrite += call.cacheWrite;
  row.tOutput += call.output;
  rows.set(key, row);
}

const pct = (part: number, whole: number) =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1).padStart(5)}%` : "    -";
const usd = (value: number) => `$${value.toFixed(0)}`.padStart(8);
const mtok = (value: number) => `${(value / 1e6).toFixed(0)}M`.padStart(8);

function report(title: string, keyOf: (call: ApiCall) => string, subset: readonly ApiCall[]) {
  const rows = new Map<string, Row>();
  for (const call of subset) tally(rows, keyOf(call), call);
  console.log(`\n== ${title}`);
  console.log(
    "key".padEnd(34) +
      "calls".padStart(8) +
      "total$".padStart(8) +
      " read$%  write$%  uncach$% output$%" +
      "   tRead   tWrite  tUncach  tOutput",
  );
  const sorted = [...rows.entries()].toSorted(([, a], [, b]) => b.usd - a.usd);
  const all = sorted.reduce((sum, [, row]) => {
    for (const key of Object.keys(row) as (keyof Row)[]) sum[key] += row[key];
    return sum;
  }, emptyRow());
  for (const [key, row] of [...sorted, ["TOTAL", all] as const]) {
    console.log(
      key.padEnd(34).slice(0, 34) +
        String(row.calls).padStart(8) +
        usd(row.usd) +
        " " +
        pct(row.cacheRead, row.usd) +
        "  " +
        pct(row.cacheWrite, row.usd) +
        "   " +
        pct(row.input, row.usd) +
        "   " +
        pct(row.output, row.usd) +
        mtok(row.tRead) +
        " " +
        mtok(row.tWrite) +
        " " +
        mtok(row.tUncached) +
        " " +
        mtok(row.tOutput),
    );
  }
  if (all.unsplitUsd > 0) console.log(`  unsplit provider-reported cost: ${usd(all.unsplitUsd)}`);
}

const latest = Math.max(...calls.map((call) => call.timestampMs));
const within = (days: number) =>
  calls.filter((call) => call.timestampMs >= latest - days * 86_400_000);
console.log(`calls ${calls.length}, latest ${new Date(latest).toISOString()}`);
const unpriced = calls.filter((call) => price(rates, call).costSource === "unpriced");
const unpricedModels = new Map<string, number>();
for (const call of unpriced) {
  unpricedModels.set(call.model, (unpricedModels.get(call.model) ?? 0) + 1);
}
console.log(`unpriced calls ${unpriced.length}`, Object.fromEntries(unpricedModels));

report("all retained, by provider", (call) => call.provider, calls);
report("last 30 days, by provider", (call) => call.provider, within(30));
report("last 30 days, by model", (call) => `${call.model} ${call.speed}`, within(30));
report("last 7 days, by model", (call) => `${call.model} ${call.speed}`, within(7));
