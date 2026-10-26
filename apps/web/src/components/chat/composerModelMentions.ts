import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { rankModelPickerSearch } from "./modelPickerSearch";
import { getDisplayModelName, getProviderRowLabel, type ModelEsque } from "./providerIconUtils";

type ComposerModelItem = Extract<ComposerCommandItem, { type: "model" }>;

type ComposerModelMentionProvider = Pick<
  ProviderInstanceEntry,
  | "instanceId"
  | "driverKind"
  | "displayName"
  | "acpRegistryAgentId"
  | "acpRegistryIconUrl"
  | "continuationGroupKey"
  | "enabled"
  | "isAvailable"
  | "status"
>;

const COMPOSER_MODEL_MENTION_LIMIT = 6;

/** A mention can't hold a space, so `@traex:gpt`, `@opencode/gpt` and `@traex-gpt` split into words. */
function mentionSearchQueries(query: string): ReadonlyArray<string> {
  const spaced = query.replace(/[:/]+/gu, " ").trim();
  if (spaced.length === 0) return [];
  const unhyphenated = spaced.replace(/-+/gu, " ").trim();
  return unhyphenated === spaced ? [spaced] : [spaced, unhyphenated];
}

export function matchComposerModelItems(input: {
  readonly instanceEntries: ReadonlyArray<ComposerModelMentionProvider>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey: string | null | undefined;
  readonly isModelDisabled: (instanceId: ProviderInstanceId, model: string) => boolean;
  readonly query: string;
}): ComposerModelItem[] {
  const queries = mentionSearchQueries(input.query);
  if (queries.length === 0) return [];

  const candidates: Array<{ entry: ComposerModelMentionProvider; option: ModelEsque }> = [];
  for (const entry of input.instanceEntries) {
    if (!isProviderInstancePickerReady(entry)) continue;
    if (
      input.lockedProvider !== null &&
      (entry.driverKind !== input.lockedProvider ||
        (input.lockedContinuationGroupKey &&
          entry.continuationGroupKey !== input.lockedContinuationGroupKey))
    ) {
      continue;
    }
    for (const option of input.modelOptionsByInstance.get(entry.instanceId) ?? []) {
      if (option.isUnavailable || input.isModelDisabled(entry.instanceId, option.slug)) continue;
      candidates.push({ entry, option });
    }
  }

  for (const query of queries) {
    // Literal words only: fuzzy model hits would push file matches out of the `@` menu.
    const words = query.toLowerCase().split(/\s+/u);
    const literalCandidates = candidates.filter(({ entry, option }) => {
      const haystack = [
        option.name,
        option.shortName,
        option.subProvider,
        entry.driverKind,
        entry.displayName,
      ]
        .join(" ")
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    const ranked = rankModelPickerSearch(literalCandidates, query, ({ entry, option }) => ({
      name: option.name,
      ...(option.shortName ? { shortName: option.shortName } : {}),
      ...(option.subProvider ? { subProvider: option.subProvider } : {}),
      driverKind: entry.driverKind,
      providerDisplayName: entry.displayName,
    }));
    if (ranked.length === 0) continue;
    return ranked.slice(0, COMPOSER_MODEL_MENTION_LIMIT).map(({ entry, option }) => ({
      id: `model:${entry.instanceId}:${option.slug}`,
      type: "model",
      instanceId: entry.instanceId,
      model: option.slug,
      driverKind: entry.driverKind,
      providerDisplayName: entry.displayName,
      acpRegistryAgentId: entry.acpRegistryAgentId,
      acpRegistryIconUrl: entry.acpRegistryIconUrl,
      label: getDisplayModelName(option),
      description: getProviderRowLabel(entry.displayName, option.subProvider),
    }));
  }
  return [];
}
