// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import {
  parseRateTable,
  priceUsage,
  type PricedRecord,
  type PricedUsage,
  type RateTable,
} from "../../apps/server/src/usage/usagePricing.ts";

const SPEEDS = ["standard", "fast", "ultrafast"] as const;
type Speed = (typeof SPEEDS)[number];

export interface ApiCall {
  readonly provider: string;
  readonly file: string;
  readonly sessionId: string;
  readonly timestampMs: number;
  readonly model: string;
  readonly speed: Speed;
  readonly dedupeKey: string | null;
  readonly priced: PricedRecord;
  readonly uncached: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

/** Everything the provider must read for this call. Output is excluded. */
export const promptTokens = (call: ApiCall) => call.uncached + call.cacheRead + call.cacheWrite;

type SerializedRecord = readonly [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  dedupeKey: string | null,
  reportedCostUsd: number | null,
  speed: number,
  rateModelIndex?: number | null,
  unresolvedServiceTierTurnId?: string,
];

interface SerializedCache {
  readonly models: readonly string[];
  readonly sessions: readonly string[];
  readonly files: Readonly<
    Record<
      string,
      {
        readonly p: string;
        readonly r: readonly SerializedRecord[];
        readonly t?: readonly SerializedRecord[];
      }
    >
  >;
}

// Mirrors UsageService: moved copies of a shared session are dropped, repeated events in one file stay.
const SHARED_SESSION_PROVIDERS = new Set(["codex"]);

/** Loads a copy of T3's usage scan cache with the Usage page's deduplication applied. */
export function loadApiCalls(scanCachePath: string): ApiCall[] {
  const cache = JSON.parse(NodeFS.readFileSync(scanCachePath, "utf8")) as SerializedCache;
  const filesBySession = new Map<string, Set<string>>();
  for (const [file, entry] of Object.entries(cache.files)) {
    for (const row of [...entry.r, ...(entry.t ?? [])]) {
      const sessionId = cache.sessions[row[2]] ?? "";
      if (sessionId.length === 0) continue;
      const seen = filesBySession.get(sessionId) ?? new Set();
      seen.add(file);
      filesBySession.set(sessionId, seen);
    }
  }

  const seen = new Set<string>();
  const calls: ApiCall[] = [];
  for (const [file, entry] of Object.entries(cache.files)) {
    const occurrences = new Map<string, number>();
    for (const row of [...entry.r, ...(entry.t ?? [])]) {
      const [ts, modelIndex, sessionIndex, uncached, cacheRead, cacheWrite, output, reasoning] =
        row;
      const model = cache.models[modelIndex] ?? "";
      const sessionId = cache.sessions[sessionIndex] ?? "";
      let dedupeKey = row[8];
      if (SHARED_SESSION_PROVIDERS.has(entry.p) && (filesBySession.get(sessionId)?.size ?? 0) > 1) {
        const key = JSON.stringify([
          entry.p,
          sessionId,
          ts,
          model,
          uncached,
          cacheRead,
          cacheWrite,
        ]);
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        dedupeKey = `${key}:${occurrence}`;
      }
      if (dedupeKey !== null) {
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
      }
      const speed = SPEEDS[row[10]] ?? "standard";
      const rateModelIndex = row[11];
      const rateModel =
        typeof rateModelIndex === "number" ? cache.models[rateModelIndex] : undefined;
      calls.push({
        provider: entry.p,
        file,
        sessionId,
        timestampMs: ts,
        model,
        speed,
        dedupeKey: row[8],
        uncached,
        cacheRead,
        cacheWrite,
        output,
        priced: {
          model,
          ...(rateModel === undefined ? {} : { rateModel }),
          speed,
          reportedCostUsd: row[9],
          totals: {
            uncachedInputTokens: uncached,
            cachedInputTokens: cacheRead,
            cacheCreationTokens: cacheWrite,
            outputTokens: output,
            reasoningTokens: reasoning,
          },
        },
      });
    }
  }
  return calls;
}

export function loadRates(ratesPath: string): RateTable {
  const { document } = JSON.parse(NodeFS.readFileSync(ratesPath, "utf8")) as { document: unknown };
  return parseRateTable(document);
}

export const price = (rates: RateTable, call: ApiCall): PricedUsage =>
  priceUsage(rates, call.priced);
