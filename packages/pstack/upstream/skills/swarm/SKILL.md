---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for $pstack:swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

Use `delegate_task` for every spawn. Copy the named role's exact resolved target from `<t3_pstack>` into `target`, including the complete `options` array. An `inherit` seat omits `target`. Repeat fallback notes and compare the spawn's provider, model, and options with the request. Report a rejected or mismatched target; never substitute one. If a required role is missing, stop that spawn. Call `orchestrator_capabilities` once before the first delegation. Start each brief with the absolute `<pstack>` and `<models>` paths; include the relevant resolved role lines when children will delegate. Retain every `taskId`. With `mode: "async"`, spawn the wave and end the turn; completion wakes the parent. Do not poll children. Use `mode: "wait"` only when this turn needs the result; a wait timeout does not cancel the child. Cancel replaced or unneeded work with `task_cancel`.

## Start

Open a plan using the harness plan tool, or a list in the reply with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Use the `swarm workers` role's resolved target in `<t3_pstack>`. For a model race, obtain explicitly resolved targets for each arm before spawning; never invent models or adjust options.

## Phase B: Fan out

Spawn all N workers with `delegate_task`, `role: "test"`, `isolation: "worktree"`, `mode: "async"`, and the step 3 target. Use the shared checkout only when a worker needs local resources; give each worker explicit output ownership.

A worktree starts at the parent checkout's committed local HEAD. Arrange a needed committed base before spawning, within existing authorization. A branch name in a brief cannot select the initial checkout. If the requested base cannot be arranged, report that placement cannot be honored.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

## Phase D: Report

Return one consolidated in-chat report with a result table, issue one-liners, gaps or dropouts, and the race rule when used.
