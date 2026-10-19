import {
  findProviderPool,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

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

/** A thread records the account that ran it; a composer keys its selection by the pool that hides that account. */
export function composerModelSelectionFor<Selection extends Pick<ModelSelection, "instanceId">>(
  providers: ReadonlyArray<ServerProvider>,
  selection: Selection,
): Selection {
  const instanceId = composerInstanceIdFor(providers, selection.instanceId);
  return instanceId === selection.instanceId ? selection : { ...selection, instanceId };
}
