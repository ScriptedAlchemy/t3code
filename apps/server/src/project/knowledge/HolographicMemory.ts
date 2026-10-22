import * as NodeModule from "node:module";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Path from "effect/Path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  factSearchTokens,
  lexicalComponents,
  projectMemorySearchTokens,
} from "./holographicScoring.ts";

const failureMessages = {
  unavailable: "Project memory ranking is unavailable.",
  capacity: "Project memory ranking is at capacity.",
  invalidInput: "Project memory ranking received an invalid or oversized batch.",
  failed: "Project memory ranking failed.",
};

export class HolographicMemoryError extends Schema.TaggedError<HolographicMemoryError>()(
  "HolographicMemoryError",
  {
    reason: Schema.Literals(["unavailable", "capacity", "invalidInput", "failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return failureMessages[this.reason];
  }
}

type Candidate = {
  readonly id: string;
  readonly content: string;
  readonly entities: readonly string[];
  readonly tags: readonly string[];
  readonly trust: number;
  readonly updatedAt: number;
  readonly retrievalCount: number;
  readonly ftsRank?: number;
};
type Evidence = {
  readonly rawCosine: number;
  readonly holographic: number;
  readonly decay: number;
  readonly reinforcement: number;
  readonly score: number;
  readonly scoreMillionths: number;
};
type NativeCandidate = Omit<Candidate, "id" | "tags" | "ftsRank"> & {
  readonly fts: number;
  readonly jaccard: number;
};
type NativeKernel = {
  readonly rankBatch: (
    query: string,
    tokens: readonly string[],
    candidates: readonly NativeCandidate[],
    now: number,
    signal: AbortSignal,
  ) => Promise<Evidence[]>;
};
type ScoredCandidate = Evidence & {
  readonly id: string;
  readonly tokenOverlap: number;
  readonly fts: number;
  readonly coverage: number;
};

export class HolographicMemory extends Context.Service<
  HolographicMemory,
  {
    readonly scoreCandidates: (input: {
      readonly query: string;
      readonly candidates: readonly Candidate[];
      readonly now: number;
    }) => Effect.Effect<readonly ScoredCandidate[], HolographicMemoryError>;
  }
>()("t3/project/knowledge/HolographicMemory") {}

// Cancellation stops between encodings. Native admission stays held until work
// finishes, so interrupted requests cannot grow the worker queue.
const MAX_CANDIDATES = 1_000;
const MAX_TEXT_BYTES = 16_384;
const MAX_BATCH_BYTES = 131_072;
const MAX_BATCH_SIZE = 32;

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const kernel = yield* Effect.cached(
    Effect.try({
      try: () => {
        const require = NodeModule.createRequire(import.meta.url);
        const filename = `project-memory-${platform}-${architecture}.node`;
        const paths = [
          path.join(import.meta.dirname, "project-memory", filename),
          path.resolve(import.meta.dirname, "../../../../../native/project-memory/build", filename),
        ];
        const resolved = paths.find((path) => {
          try {
            require.resolve(path);
            return true;
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "MODULE_NOT_FOUND")
              return false;
            throw cause;
          }
        });
        if (!resolved) throw new Error("Project memory native artifact is missing");
        return require(resolved) as NativeKernel;
      },
      catch: (cause) => new HolographicMemoryError({ reason: "unavailable", cause }),
    }),
  );
  const scoreCandidates: HolographicMemory["Service"]["scoreCandidates"] = Effect.fn(
    "HolographicMemory.scoreCandidates",
  )(function* (input) {
    if (
      input.candidates.length > MAX_CANDIDATES ||
      !Number.isSafeInteger(input.now) ||
      Buffer.byteLength(input.query) > 4_096
    ) {
      return yield* new HolographicMemoryError({ reason: "invalidInput" });
    }
    const tokens = projectMemorySearchTokens(input.query);
    const queryBytes =
      Buffer.byteLength(input.query) +
      tokens.reduce((sum, token) => sum + Buffer.byteLength(token), 0);
    if (tokens.length > 64) return yield* new HolographicMemoryError({ reason: "invalidInput" });
    const ids = new Set<string>();
    const sizes: number[] = [];
    for (const candidate of input.candidates) {
      const bytes =
        Buffer.byteLength(candidate.content) +
        candidate.entities.reduce((sum, entity) => sum + Buffer.byteLength(entity), 0);
      if (
        ids.has(candidate.id) ||
        bytes > MAX_TEXT_BYTES ||
        candidate.entities.length > 64 ||
        candidate.tags.length > 64 ||
        candidate.tags.some((tag) => Buffer.byteLength(tag) > 256) ||
        !Number.isFinite(candidate.trust) ||
        !Number.isSafeInteger(candidate.updatedAt) ||
        !Number.isSafeInteger(candidate.retrievalCount) ||
        candidate.retrievalCount < 0
      ) {
        return yield* new HolographicMemoryError({ reason: "invalidInput" });
      }
      ids.add(candidate.id);
      sizes.push(bytes);
    }
    const native = yield* kernel;
    const relevance = (rank: number | undefined) =>
      rank !== undefined && Number.isFinite(rank) ? Math.max(0, -rank) : 0;
    const maxRelevance = input.candidates.reduce(
      (max, candidate) => Math.max(max, relevance(candidate.ftsRank)),
      0,
    );
    const eligible = input.candidates.flatMap((candidate, index) => {
      const lexical = lexicalComponents(
        tokens,
        factSearchTokens(candidate),
        maxRelevance <= Number.EPSILON ? 0 : relevance(candidate.ftsRank) / maxRelevance,
      );
      if (
        tokens.length > 0 &&
        Math.round(lexical.fts * 1_000_000) === 0 &&
        Math.round(lexical.tokenOverlap * 1_000_000) === 0
      )
        return [];
      return [{ candidate, lexical, bytes: sizes[index]! }];
    });
    const scored: (ScoredCandidate & { readonly updatedAt: number })[] = [];
    for (let offset = 0; offset < eligible.length;) {
      const batch: typeof eligible = [];
      let bytes = queryBytes;
      while (
        offset < eligible.length &&
        batch.length < MAX_BATCH_SIZE &&
        bytes + eligible[offset]!.bytes <= MAX_BATCH_BYTES
      ) {
        const entry = eligible[offset++]!;
        batch.push(entry);
        bytes += entry.bytes;
      }
      const evidence = yield* Effect.tryPromise({
        try: (signal) =>
          native.rankBatch(
            input.query,
            tokens,
            batch.map(({ candidate, lexical }) => ({
              content: candidate.content,
              entities: candidate.entities,
              trust: candidate.trust,
              updatedAt: candidate.updatedAt,
              retrievalCount: candidate.retrievalCount,
              fts: lexical.fts,
              jaccard: lexical.tokenOverlap,
            })),
            input.now,
            signal,
          ),
        catch: (cause) =>
          new HolographicMemoryError({
            reason:
              cause instanceof Error && "code" in cause && cause.code === "QueueFull"
                ? "capacity"
                : cause instanceof Error && "code" in cause && cause.code === "InvalidArg"
                  ? "invalidInput"
                  : "failed",
            cause,
          }),
      });
      for (const [index, entry] of batch.entries())
        scored.push({
          id: entry.candidate.id,
          updatedAt: entry.candidate.updatedAt,
          ...entry.lexical,
          ...evidence[index]!,
        });
    }
    return scored
      .sort(
        (left, right) =>
          right.scoreMillionths - left.scoreMillionths ||
          right.updatedAt - left.updatedAt ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      )
      .map(({ updatedAt: _updatedAt, ...score }) => score);
  });
  return HolographicMemory.of({ scoreCandidates });
});

export const layer = Layer.effect(HolographicMemory, make);
