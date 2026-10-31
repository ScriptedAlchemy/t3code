---
name: automate-team
description: "Discover a repository's active core contributors and create or refresh a team mode from their engineering activity. Use for automate team or capture this repository's maintainer conventions."
disable-model-invocation: true
---

# Automate team

Use `delegate_task` for every spawn. Arena runners, architect runners, and interrogate reviewers are panels: one child per seat, including fallbacks. An `unavailable` seat is not a target: retain its panel position, refresh capabilities, report the blocked seat, and do not launch it until a valid target is resolved. Every other role is a pool: pick the seat whose model best fits the job; spread same-role children in a wave across seats. Arena cross-judges prefer a different model family. Copy the chosen target from `<t3_pstack>` exactly, including all options; `inherit` means the parent model and omits `target`. If a pool spawn is rejected, report it and try the next seat; never invent targets or change options. Repeat fallback notes and report provider, model, or option mismatches. If a required role is missing, stop that spawn. Call `orchestrator_capabilities` before the first delegation and again when availability changes or a target is rejected. Resolved roles are a snapshot. An explicit user change supersedes it; validate the requested target and options against fresh capabilities. After setup writes new choices, do not reuse the older snapshot for changed roles. Start each brief with the absolute `<pstack>` and `<models>` paths; include the relevant resolved role lines when children will delegate. Retain every `taskId`. With `mode: "async"`, spawn the wave and end the turn; completion wakes the parent. Do not poll children. Use `mode: "wait"` only when this turn needs the result; a wait timeout does not cancel the child. Cancel replaced or unneeded work with `task_cancel`.

Discover a repository's active core contributors and build a mode from their observed engineering conventions. Use [automate-maintainer](../automate-maintainer/SKILL.md) for mining, attribution, group synthesis, authoring, and evaluation; read it before collecting training evidence.

## Establish scope

Accept a repository URL or `owner/repo`, otherwise resolve the checkout's Git remote. Ask which repository only when remotes make the intended scope unclear. Verify visibility and default branch through an authenticated GitHub MCP server or `gh`. Default to the last 12 months; several repositories need separate ownership and visibility records. Linked projects supply context without expanding the crawl.

## Discover the roster

Read [roster discovery](references/roster-discovery.md). Compare declared ownership with substantive authorship, reviews, design discussions, triage, and release activity. Exclude bots and distinguish active owners from inactive declared maintainers and uncertain candidates. Counts alone do not establish a core role.

Report the inferred roster with ownership evidence and proceed with well-supported accounts. Honor supplied inclusions and exclusions. Ask with the harness question tool only when identity, an uncertain inclusion, scope, or crawl size changes the work. Do not silently reduce "all core contributors" to the busiest few. Process large rosters in batches, and record every included person and any unfinished coverage.

## Mine, draft, and validate

Pass the roster, repository, window, ownership evidence, destination, and omissions to automate-maintainer. Reserve held-out evaluation cases before reading their conversations. Collect each person's record separately; delegate to `delegate_task` subagents only when allowed, using the `how explorer` role's exact resolved target from `<t3_pstack>`, with bounded scope and output ownership.

Default to one `<repo>-team-mode` in `.agents/skills/` with individual evidence in references. Create separately invocable individual modes when requested. Preserve an existing team mode's name, category, and frontmatter.

State shared conventions, supported ownership, and disagreements. Repository requirements can apply across the team without proving each contributor's preference. Do not claim unanimity from missing evidence or resolve conflicts by activity counts.

Validate through automate-maintainer's [evaluation procedure](../automate-maintainer/references/evaluation.md). Report roster and source coverage, unsupported areas, and validation limits. Land within existing authorization; creating a mode does not launch a team, authorize communication as its members, or schedule crawling.

## Refresh

Compare roster and ownership with the previous evidence cutoff. Reassess departed or inactive contributors, new owners, changed conventions, and counterexamples. Preserve supported rules; remove contradicted claims. Record membership changes and the new cutoff so the next refresh can continue without repeating the crawl.

Use automate-maintainer for a supplied person or group, and automate-me for the user's conversation history.

Project skills live in `.agents/skills/`. If `.claude/skills` is absent, create a symlink to `../.agents/skills` for Claude discovery; preserve an existing directory. For a personal skill, ask which harness should load it and use that harness's actual user-skill directory. T3 has no universal user-skill folder.
