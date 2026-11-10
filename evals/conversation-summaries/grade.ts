import type { CondensedCase } from "./cases.ts";

const MAX_CHARS = 1_200;

/** Every way a roll-up reply breaks the case's rules; empty when it passes. */
export function gradeCondensed(
  fixture: CondensedCase,
  statements: ReadonlyArray<{ readonly text: string; readonly citations: ReadonlyArray<string> }>,
): ReadonlyArray<string> {
  const refs = new Set(fixture.summaries.map((_, index) => `M${index + 1}`));
  const texts = statements.map((statement) => statement.text);
  const failures: Array<string> = [];
  if (statements.length === 0) failures.push("no statements");
  for (const statement of statements)
    if (!statement.citations.some((ref) => refs.has(ref.trim())))
      failures.push(`cites no given source: ${statement.text}`);
  const chars = texts.reduce((sum, text) => sum + text.trim().length, 0);
  if (chars > MAX_CHARS) failures.push(`${chars} characters, over ${MAX_CHARS}`);
  for (const pattern of fixture.mustMention)
    if (!texts.some((text) => new RegExp(pattern).test(text))) failures.push(`missing ${pattern}`);
  for (const rule of fixture.attributed)
    for (const text of texts)
      if (new RegExp(rule.when).test(text) && !new RegExp(rule.require, "i").test(text))
        failures.push(`${rule.when} without ${rule.require}: ${text}`);
  for (const pattern of fixture.mustNot)
    for (const text of texts)
      if (new RegExp(pattern, "i").test(text)) failures.push(`${pattern}: ${text}`);
  return failures;
}
