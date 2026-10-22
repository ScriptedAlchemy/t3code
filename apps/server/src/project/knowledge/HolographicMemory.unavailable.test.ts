import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HolographicMemory from "./HolographicMemory.ts";

vi.mock("node:module", () => ({
  createRequire: () =>
    Object.assign(
      () => {
        throw new Error("missing native artifact");
      },
      {
        resolve: () => {
          throw Object.assign(new Error("missing native artifact"), { code: "MODULE_NOT_FOUND" });
        },
      },
    ),
}));

it.effect(
  "constructs the service without the addon and returns typed unavailability on recall",
  () =>
    Effect.gen(function* () {
      const memory = yield* HolographicMemory.HolographicMemory;
      const error = yield* memory
        .scoreCandidates({ query: "sqlite", candidates: [], now: 1_000 })
        .pipe(Effect.flip);
      assert.instanceOf(error, HolographicMemory.HolographicMemoryError);
      assert.equal(error.reason, "unavailable");
    }).pipe(Effect.provide(HolographicMemory.layer.pipe(Layer.provide(NodeServices.layer)))),
);
