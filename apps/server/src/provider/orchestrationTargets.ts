import {
  isProviderAvailable,
  findProviderPool,
  providerLimitedUntilMs,
  type ProjectId,
  type ServerProvider,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { poolMemberHealth } from "../orchestration-v2/ProviderPoolRouting.ts";
import * as Effect from "effect/Effect";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";

export function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (!provider.enabled) {
    constraints.push("Provider instance is disabled.");
    // Disabled snapshots contain placeholders for installation, health, and auth.
    return constraints;
  }
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

export function delegationProviderConstraints(
  provider: ServerProvider,
  supportsOrchestrationV2: boolean,
  input: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly settings: Parameters<typeof poolMemberHealth>[0]["settings"];
    readonly projectId: ProjectId | null;
    readonly nowMs: number;
  },
): ReadonlyArray<string> {
  const constraints = [...providerConstraints(provider, supportsOrchestrationV2)];
  const owner = findProviderPool(input.providers, provider.instanceId);
  if (owner === null) {
    if (providerLimitedUntilMs(provider, input.nowMs) !== null) {
      constraints.push("Provider is rate limited. Retry after its cooldown expires.");
    }
    return constraints;
  }
  const members = poolMemberHealth({ ...input, members: owner.members });
  const eligible = members.filter((member) => member.eligible);
  if (eligible.length === 0) {
    constraints.push("No pool member is available for this project.");
  } else if (eligible.every((member) => member.limitedUntilMs !== null)) {
    constraints.push(
      "Every available pool member is rate limited. Retry after a cooldown expires.",
    );
  }
  return constraints;
}

/** Skip checks without descriptors; reject duplicate IDs because consumers disagree on precedence. */
export function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

export const readOrchestrationProviders = Effect.fn("OrchestrationTargets.readProviders")(
  function* () {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const [providers, instanceIds] = yield* Effect.all([
      registry.getPublishedProviders,
      adapters.list(),
    ]);
    // A pool has no adapter of its own; routing picks a member's at dispatch.
    const capableInstanceIds = new Set([
      ...instanceIds,
      ...providers
        .filter((provider) => provider.pool?.role === "pool")
        .map((provider) => provider.instanceId),
    ]);
    return { providers, capableInstanceIds };
  },
);
