# Scope and naming

Accept GitHub logins, profile URLs, or a list of either. Resolve and deduplicate accounts, exclude bots, and verify identities before collecting activity. Use the supplied repository or organization scope. Otherwise infer the current repository from its Git remote. Ask only for missing information that changes the work. Default to the last 12 months and the narrowest useful scope. Do not silently widen to other repositories or older activity when evidence is sparse.

If no maintainer is named, rank human authors and reviewers of recent merged PRs in scope, then ask the user to select accounts. Activity counts identify candidates; they do not establish authority or expertise.

For one person, use `<login>-mode`. If that name belongs to an automate-me personal mode, use `<login>-maintainer-mode` and explain the distinction in the opening. For several people, default to one mode per login plus a group mode named `<repo>-maintainers-mode`. Use a supplied group name when given. For an organization or global scope without a useful repo name, choose a short descriptive group name and state it. If the user requests only a group skill, retain individual evidence in its references without installing individual modes.

Look for existing modes recursively in project `.agents/skills/` and personal `the selected harness's user-skill directory/`. Preserve their categories and invocation policies. Inspect an existing skill before updating it. Migrate a legacy `<login>-maintainer` directory only after updating its references and checking the destination for collisions. Never overwrite an unrelated mode.

Record the accounts, repositories, evidence window, intended jobs, output paths, and repository visibility. Infer jobs from the request; otherwise cover code writing and review first. Ask about ownership areas or exclusions only when the evidence reveals a meaningful choice.

Default new project modes to `.agents/skills/<mode-name>/SKILL.md`. Use the personal skill location when requested. For updates, mine activity since the last evidence cutoff recorded in the existing skill, while retaining enough older evidence to reassess its rules. File edit time alone does not establish that cutoff.
