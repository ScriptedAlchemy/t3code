import { describe, expect, it } from "vite-plus/test";
import type { SkillsLibraryStatus } from "@t3tools/contracts";
import {
  filterSkillsLibraryIssues,
  skillsLibraryIssues,
  skillsLibraryIssueSummary,
} from "./skillsLibraryIssues.ts";

const empty: SkillsLibraryStatus = {
  libraryPath: "~/.agents/skills",
  linked: [],
  conflicts: [],
  nameMismatches: [],
};

describe("skills library issues", () => {
  it("lists every conflict and name mismatch and searches names, kinds and paths", () => {
    const status: SkillsLibraryStatus = {
      ...empty,
      conflicts: [
        { name: "review", paths: ["~/.claude/skills/review", "~/.agents/skills/review"] },
        {
          name: "deploy",
          paths: ["~/.agents/skills/deploy", "~/.agents/skills/deploy/run.sh"],
          reason: "outsideLink",
        },
      ],
      nameMismatches: [{ name: "lint", frontmatterName: "linter" }],
    };
    const issues = skillsLibraryIssues(status);
    expect(issues.map((issue) => [issue.name, issue.kind])).toEqual([
      ["review", "Copies differ"],
      ["deploy", "Link outside the skill"],
      ["lint", 'Named "linter" in SKILL.md'],
    ]);
    expect(skillsLibraryIssueSummary(status)).toBe("2 conflicts · 1 name mismatch");
    expect(skillsLibraryIssueSummary(empty)).toBeNull();
    expect(filterSkillsLibraryIssues(issues, " RUN.SH ").map((issue) => issue.name)).toEqual([
      "deploy",
    ]);
    expect(filterSkillsLibraryIssues(issues, "linter").map((issue) => issue.name)).toEqual([
      "lint",
    ]);
    expect(filterSkillsLibraryIssues(issues, "  ")).toBe(issues);
  });
});
