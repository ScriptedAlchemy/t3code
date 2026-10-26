import { rankModelPickerSearch, type ModelPickerSearchableModel } from "./modelSearch.ts";

const COMPOSER_MODEL_MENTION_LIMIT = 8;

/** A mention can't hold a space, so `@traex:gpt`, `@opencode/gpt` and `@traex-gpt` split into words. */
function mentionSearchQueries(query: string): ReadonlyArray<string> {
  const spaced = query.replace(/[:/]+/gu, " ").trim();
  if (spaced.length === 0) return [];
  const unhyphenated = spaced.replace(/-+/gu, " ").trim();
  return unhyphenated === spaced ? [spaced] : [spaced, unhyphenated];
}

/** Ranks the models an `@` mention names. A bare `@` names none. */
export function rankComposerModelMentions<T>(
  candidates: ReadonlyArray<T>,
  query: string,
  toSearchable: (candidate: T) => ModelPickerSearchableModel,
): T[] {
  for (const words of mentionSearchQueries(query)) {
    // Literal words only: fuzzy model hits would push file matches out of the `@` menu.
    const tokens = words.toLowerCase().split(/\s+/u);
    const literal = candidates.filter((candidate) => {
      const model = toSearchable(candidate);
      const haystack = [
        model.name,
        model.shortName,
        model.subProvider,
        model.driverKind,
        model.providerDisplayName,
      ]
        .join(" ")
        .toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
    const ranked = rankModelPickerSearch(literal, words, toSearchable);
    if (ranked.length > 0) return ranked.slice(0, COMPOSER_MODEL_MENTION_LIMIT);
  }
  return [];
}
