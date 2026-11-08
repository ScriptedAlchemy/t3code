import type { SkillsLibraryStatus } from "@t3tools/contracts";

export interface SkillsLibraryIssue {
  readonly key: string;
  readonly name: string;
  readonly kind: string;
  readonly paths: readonly string[];
  readonly guidance: string;
}

export function skillsLibraryIssues(status: SkillsLibraryStatus): SkillsLibraryIssue[] {
  return [
    ...status.conflicts.map((conflict) =>
      conflict.reason === "outsideLink"
        ? {
            key: `conflict:${conflict.name}`,
            name: conflict.name,
            kind: "Link outside the skill",
            paths: conflict.paths,
            guidance:
              "The second path is a link inside the skill whose target lies outside it. Replace the link with the file before refreshing.",
          }
        : {
            key: `conflict:${conflict.name}`,
            name: conflict.name,
            kind: "Copies differ",
            paths: conflict.paths,
            guidance: "These copies differ. Keep one copy before refreshing.",
          },
    ),
    ...status.nameMismatches.map((mismatch) => ({
      key: `name:${mismatch.name}`,
      name: mismatch.name,
      kind: `Named "${mismatch.frontmatterName}" in SKILL.md`,
      paths: [],
      guidance: `Some providers use the folder name and others use "${mismatch.frontmatterName}".`,
    })),
  ];
}

export function skillsLibraryIssueSummary(status: SkillsLibraryStatus): string | null {
  const plural = (count: number, one: string, many: string) =>
    count === 0 ? null : `${count} ${count === 1 ? one : many}`;
  const parts = [
    plural(status.conflicts.length, "conflict", "conflicts"),
    plural(status.nameMismatches.length, "name mismatch", "name mismatches"),
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

export function filterSkillsLibraryIssues(
  issues: readonly SkillsLibraryIssue[],
  query: string,
): readonly SkillsLibraryIssue[] {
  const needle = query.trim().toLowerCase();
  return needle
    ? issues.filter((issue) =>
        [issue.name, issue.kind, ...issue.paths].some((text) =>
          text.toLowerCase().includes(needle),
        ),
      )
    : issues;
}
