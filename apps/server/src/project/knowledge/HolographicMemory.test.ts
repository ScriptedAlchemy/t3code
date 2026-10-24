import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HolographicMemory from "./HolographicMemory.ts";
import { projectMemorySearchTokens } from "./holographicScoring.ts";

const candidate = (
  id: string,
  overrides: Partial<
    Parameters<
      HolographicMemory.HolographicMemory["Service"]["scoreCandidates"]
    >[0]["candidates"][number]
  > = {},
) => ({
  id,
  content: "sqlite",
  entities: ["sqlite"],
  tags: [],
  trust: 1,
  updatedAt: 1_000,
  retrievalCount: 0,
  ...overrides,
});

it("retains the distinct ASCII search tokenizer", () => {
  assert.deepEqual(
    projectMemorySearchTokens(
      "The AND a src/lib.rs crate::Thing foo.bar _ GrüßE 東京 SQLite sqlite",
    ),
    ["and", "crate::thing", "foo.bar", "gr", "sqlite", "src/lib.rs", "the"],
  );
});

it.effect("ranks real native cosine with lexical admission and tag evidence", () =>
  Effect.gen(function* () {
    const memory = yield* HolographicMemory.HolographicMemory;
    const scores = yield* memory.scoreCandidates({
      query: "sqlite",
      now: 1_000,
      candidates: [
        candidate("match", { ftsRank: -2 }),
        candidate("unrelated", { content: "postgres", entities: [] }),
        candidate("tag", { content: "database", entities: [], tags: ["sqlite"] }),
      ],
    });
    assert.deepEqual(
      scores.map((score) => score.id),
      ["match", "tag"],
    );
    const match = scores[0]!;
    assert.approximately(match.rawCosine, 1, 1e-14);
    assert.equal(match.holographic, 1);
    assert.equal(match.fts, 1);
    assert.equal(match.tokenOverlap, 1);
    assert.equal(match.scoreMillionths, 1_000_000);
    assert.equal(scores[1]!.fts, 0);
    assert.equal(scores[1]!.tokenOverlap, 0.5);
  }).pipe(Effect.provide(HolographicMemory.layer.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("applies original age, reinforcement, FTS coverage and trust", () =>
  Effect.gen(function* () {
    const memory = yield* HolographicMemory.HolographicMemory;
    const now = 365 * 86_400_000 + 1_000;
    const scores = yield* memory.scoreCandidates({
      query: "sqlite",
      now,
      candidates: [
        candidate("old", { ftsRank: -2 }),
        candidate("new", { ftsRank: -2, updatedAt: now, retrievalCount: Number.MAX_SAFE_INTEGER }),
        candidate("distrusted", { ftsRank: -2, trust: 0 }),
      ],
    });
    assert.deepEqual(
      scores.map((score) => score.id),
      ["new", "old", "distrusted"],
    );
    assert.equal(scores[0]!.reinforcement, 1.5);
    assert.equal(scores[0]!.scoreMillionths, 1_500_000);
    assert.equal(scores[1]!.decay, 0.5);
    assert.equal(scores[1]!.scoreMillionths, 500_000);
    assert.equal(scores[2]!.scoreMillionths, 0);
    const prefix = yield* memory.scoreCandidates({
      query: "sqlit",
      now,
      candidates: [candidate("prefix", { ftsRank: -1 })],
    });
    assert.equal(prefix[0]!.coverage, 1);
    assert.equal(prefix[0]!.tokenOverlap, 0);
    assert.equal(prefix[0]!.fts, 1);
  }).pipe(Effect.provide(HolographicMemory.layer.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("never reuses a fact's old content and keeps stable ordering across batches", () =>
  Effect.gen(function* () {
    const memory = yield* HolographicMemory.HolographicMemory;
    const initial = yield* memory.scoreCandidates({
      query: "sqlite",
      now: 1_000,
      candidates: [candidate("edited")],
    });
    assert.equal(initial.length, 1);
    const updated = yield* memory.scoreCandidates({
      query: "sqlite",
      now: 1_000,
      candidates: [candidate("edited", { content: "redis", entities: [] })],
    });
    assert.deepEqual(updated, []);
    const candidates = Array.from({ length: 65 }, (_, index) =>
      candidate(String(index).padStart(3, "0")),
    );
    const scores = yield* memory.scoreCandidates({
      query: "sqlite",
      now: 1_000,
      candidates: candidates.toReversed(),
    });
    assert.deepEqual(
      scores.map((score) => score.id),
      candidates.map((fact) => fact.id),
    );
  }).pipe(Effect.provide(HolographicMemory.layer.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("fails invalid inputs without accepting fabricated numeric state", () =>
  Effect.gen(function* () {
    const memory = yield* HolographicMemory.HolographicMemory;
    for (const candidates of [
      [candidate("bad", { trust: NaN })],
      [candidate("bad", { retrievalCount: -1 })],
      [candidate("bad", { content: "x".repeat(16_385) })],
      [candidate("duplicate"), candidate("duplicate")],
    ]) {
      const error = yield* memory
        .scoreCandidates({ query: "sqlite", now: 1_000, candidates })
        .pipe(Effect.flip);
      assert.equal(error.reason, "invalidInput");
    }
  }).pipe(Effect.provide(HolographicMemory.layer.pipe(Layer.provide(NodeServices.layer)))),
);
