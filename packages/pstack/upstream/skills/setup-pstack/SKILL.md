---
name: setup-pstack
description: Configure pstack's per-role models and reasoning budget for this T3 environment. Use for $pstack:setup-pstack, configure pstack models, pstack budget, or changing pstack's model choices.
---

# Setup pstack

Write the models file at the absolute `<models>` path from `<t3_pstack>`. T3 resolves that file against this environment's providers and appends exact role targets to the next pstack invocation. Skills use those targets directly.

### 1. Detect available models

Call `orchestrator_capabilities`. Use enabled instances with `canRunChildTask: true` and no `constraints`. The initial model list is short; use its `search` parameter for missing families or models named by defaults or the current file. Never write a disabled instance, unadvertised model, option ID, or option value. If the tools remain unavailable after the harness's documented fallback, say `pstack needs the t3-code tools, which this session does not expose.` and stop. `inherit-parent` and `auto` always remain valid.

### 2. Load current state

Read `<models>`. Preserve its `# budget:` line and current choices. Drop roles absent from step 5, and report them. If the file is missing, start from the defaults below. A native harness's existing model sheet may seed a proposal only when the user identifies it; validate every choice against this environment's catalog.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Use the harness question tool if available; otherwise ask in plain text and end the turn. Name the recorded budget, or say that `large` matches the defaults. Offer these exact labels:

- `unlimited — max reasoning`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Apply it.** Keep family, list, and alias choices on repeat runs. Match default `claude-*` models to enabled `claudeAgent` instances, `gpt-*` to `codex`, and `grok-*` to `grok`, offering the advertised model. If a family is unavailable, ask for a choice; propose another available family for mixed panels rather than inventing a model. Preserve all panel seats.

Find the advertised select option whose values contain at least two of `low`, `medium`, `high`, `xhigh`, `max`. Use its actual ID, including `thinking` or `variant` where advertised. Budgets target `max`, `xhigh`, `high`, or `medium` respectively. Set each real entry, including panel entries, to the requested value or the highest advertised ladder value below it. With none, mark the entry as needing a choice. Aliases, models without an effort option, and explicitly chosen off-ladder settings stay unchanged. Never select off-ladder settings under a budget.

Do not choose a latency or priority option automatically. Write such an option only when the user explicitly selects it. A budget change preserves any explicitly selected non-effort options.

**(c) Show and confirm.** Show all 17 roles with provider instance, model, and chosen options, marking unavailable entries. Offer the detected models plus `inherit-parent` and `auto`, both of which run on the parent model. Ask whether to accept or change roles. Arena runners, architect runners, and interrogate reviewers run one child per seat, aliases included. Arena selects one seat from its cross-judge pool, preferring a different model family. `swarm workers` supplies the worker target unless a race has explicitly resolved arm targets.

### 4. Validate

Validate every concrete instance, model, option ID, and value against this run's catalog. Never replace an unavailable choice silently. Ask for a valid choice. Aliases always pass.

### 5. Write the models file

The following default role block is also the server's machine-readable catalog. Keep these labels and the first fenced block under this heading intact. These are selection defaults, not literal models-file entries; resolve them to advertised instances and option IDs before writing.

```
feature, refactoring: grok-4.7-xhigh
bug-fix: grok-4.7-xhigh
perf-issue: grok-4.7-xhigh
hillclimb: grok-4.7-xhigh
judgment and prose: claude-opus-5-5-xhigh
hardest tasks: claude-opus-5-5-xhigh
how explorer: grok-4.7-xhigh
how explainer: claude-opus-5-5-xhigh
why investigators: grok-4.7-xhigh
why synthesizer: claude-opus-5-5-xhigh
reflect tooling: grok-4.7-xhigh
reflect judgment, divergent, synthesizer: claude-opus-5-5-xhigh
arena runners: claude-opus-5-5-xhigh, grok-4.7-xhigh
arena cross-judge pool: claude-opus-5-5-xhigh, grok-4.7-xhigh
swarm workers: grok-4.7-xhigh
architect runners: claude-opus-5-5-xhigh, grok-4.7-xhigh
interrogate reviewers: claude-opus-5-5-xhigh, grok-4.7-xhigh
```

Overwrite `<models>` with no frontmatter: comment lines, `# budget: <label> (<effort>)`, and one `role: value` line per role. Each value is `inherit-parent`, `auto`, or comma-separated `<instanceId>/<model> <optionId>=<value> ...` entries. Split instance from model at the first `/`; model IDs may contain more slashes. Booleans are `true` and `false`. `#` starts a comment. Only write options the user chose; T3 completes omissions from the provider's current defaults. Never write role lines into `AGENTS.md`, `CLAUDE.md`, or a harness rule folder.

### 6. Confirm

Say where the file was written and that it applies to the next pstack run in this environment. Another environment needs its own setup because provider instances differ.

### 7. Offer a verification skill (optional)

Check for a project `verify-*` skill or another real-app driver. If missing, offer once to generate one through [create-verification-skill](../create-verification-skill/SKILL.md). On yes, read and follow that file. On no, continue without pushing.

### 8. Offer a formal verification skill (optional)

If the project has no formal verifier skill, offer once to generate one through [create-formal-verification-skill](../create-formal-verification-skill/SKILL.md). On yes, read and follow it. On no, continue.
