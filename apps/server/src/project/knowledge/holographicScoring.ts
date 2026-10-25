// Derived from TraceDecay. Copyright (c) 2025 Enzo Lombardi. MIT, see native/project-memory/LICENSE.
export function projectMemorySearchTokens(text: string): string[] {
  return [
    ...new Set(
      (text.match(/[a-zA-Z0-9_/:.]+/g) ?? [])
        .filter((token) => token.length >= 2)
        .map((token) => token.toLowerCase()),
    ),
  ].sort();
}

export function factSearchTokens(fact: {
  readonly content: string;
  readonly entities: readonly string[];
  readonly tags: readonly string[];
}): string[] {
  return [
    ...new Set([fact.content, ...fact.entities, ...fact.tags].flatMap(projectMemorySearchTokens)),
  ].sort();
}

export function lexicalComponents(
  query: readonly string[],
  fact: readonly string[],
  normalizedBm25: number,
) {
  const terms = new Set(fact);
  const intersection = query.filter((token) => terms.has(token)).length;
  const tokenOverlap =
    query.length === 0 || fact.length === 0
      ? 0
      : intersection / (query.length + fact.length - intersection);
  const coverage =
    query.length === 0
      ? 0
      : query.filter(
          (token) =>
            terms.has(token) || (token.length >= 4 && fact.some((term) => term.startsWith(token))),
        ).length / query.length;
  return {
    tokenOverlap,
    coverage,
    fts: Math.min(1, Math.max(0, normalizedBm25)) * (0.5 + 0.5 * coverage),
  };
}
