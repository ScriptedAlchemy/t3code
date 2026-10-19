import type { IsoDateTime, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

/**
 * The orchestrator's in-memory view of account pools. A reference with an
 * empty default, shaped like RunFinalizationObserver, so test runtimes that
 * build the orchestrator without a provider registry route nothing.
 */
export class ProviderPoolCatalog extends Context.Reference<{
  readonly getPublishedProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly markLimited: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly until: IsoDateTime;
  }) => Effect.Effect<void>;
}>("t3/orchestration-v2/ProviderPoolCatalog", {
  defaultValue: () => ({
    getPublishedProviders: Effect.succeed([]),
    markLimited: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ProviderPoolCatalog,
  Effect.map(ProviderRegistry.ProviderRegistry, (registry) => ({
    getPublishedProviders: registry.getPublishedProviders,
    markLimited: registry.markLimited,
  })),
);
