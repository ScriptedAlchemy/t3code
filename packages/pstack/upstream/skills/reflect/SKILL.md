---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Use `delegate_task` for every spawn. Arena runners, architect runners, and interrogate reviewers are panels: one child per seat, including fallbacks. An `unavailable` seat is not a target: retain its panel position, refresh capabilities, report the blocked seat, and do not launch it until a valid target is resolved. Every other role is a pool: pick the seat whose model best fits the job; spread same-role children in a wave across seats. Arena cross-judges prefer a different model family. Copy the chosen target from `<t3_pstack>` exactly, including all options; `inherit` means the parent model and omits `target`. If a pool spawn is rejected, report it and try the next seat; never invent targets or change options. Repeat fallback notes and report provider, model, or option mismatches. If a required role is missing, stop that spawn. Call `orchestrator_capabilities` before the first delegation and again when availability changes or a target is rejected. Resolved roles are a snapshot. An explicit user change supersedes it; validate the requested target and options against fresh capabilities. After setup writes new choices, do not reuse the older snapshot for changed roles. Start each brief with the absolute `<pstack>` and `<models>` paths; include the relevant resolved role lines when children will delegate. Retain every `taskId`. With `mode: "async"`, spawn the wave and end the turn; completion wakes the parent. Do not poll children. Use `mode: "wait"` only when this turn needs the result; a wait timeout does not cancel the child. Cancel replaced or unneeded work with `task_cancel`.

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "$pstack:reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Use `orchestrator_capabilities` to identify this thread as `parentThreadId`. Find earlier threads only in the current project with `t3_thread_search` and `t3_conversation_summary_list`. Read each relevant thread with `t3_thread_read`, paging with `afterPosition`. Children are read by their returned `childThreadId`. Never read provider transcript files. Cite the returned link verbatim, or `[title](t3-thread://v1/<exact-id>)` when no link is returned.

## 2. Spawn three reviewers in parallel

Spawn three `delegate_task` reviewers with `role: "research"` and "Do not edit files, commit, or push" in their briefs. MCP access remains available. Check `git status` afterward.

Read the role targets from `<t3_pstack>`: tooling uses `reflect tooling`; judgment, divergent review, and synthesis use `reflect judgment, divergent, synthesizer`.

| Lens | Resolved role | Prompt template |
| --- | --- | --- |
| Tooling | `reflect tooling` | `references/tooling-reviewer.md` |
| Judgment | `reflect judgment, divergent, synthesizer` | `references/judgment-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | `references/divergent-reviewer.md` |

## 3. Synthesize

Spawn one synthesizer with `role: "research"` and the `reflect judgment, divergent, synthesizer` role's resolved target. Tell it "Do not edit files, commit, or push." Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It spot-verifies citations through MCP and returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Never edit a bundled skill inside `<pstack>` as durable customization; an update replaces it. Before approval, show its destination, `.agents/skills/<skill>/` or `the chosen harness user-skill directory/<skill>/`. After approval, copy the skill folder there and edit the copy. Never open a PR or push.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the `skill-creator` skill when available, otherwise write the Agent Skills folder directly and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to `skill-creator` and run its description-optimization loop.
- `new skill via skill-creator: <kebab-name>`: hand creation to `skill-creator`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
