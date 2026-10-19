import { findProviderPool, type ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

/** The pool entry for a pool id or a member id; null for an unpooled instance. */
export function providerPoolOf(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): ServerProvider | null {
  return findProviderPool(providers, instanceId)?.pool ?? null;
}

/**
 * Composer-style pickers list the pool in place of its members. A member whose
 * pool entry is missing from the list stays visible, so an account never
 * disappears from every picker at once.
 */
export function foldProviderPoolsForComposer(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers.filter(
    (provider) =>
      provider.pool?.role !== "member" || providerPoolOf(providers, provider.instanceId) === null,
  );
}

export function composerInstanceIdFor(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): ProviderInstanceId {
  return providerPoolOf(providers, instanceId)?.instanceId ?? instanceId;
}
