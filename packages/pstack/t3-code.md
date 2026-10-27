# pstack in T3 Code

pstack skills use Cursor names. In T3 Code, read this file once per session, then map each Cursor name in a skill with the tables below. Tool names here are bare; your harness may prefix them, such as `mcp__t3-code__delegate_task`.

`<pstack>` is the stable `<stateDir>/pstack/pack/` folder that holds `skills/`, `agents/`, and `docs/`. `<models>` is the pstack model file. The message that started the skill gives both as absolute paths; a delegated child gets them from its brief. If a Cursor field has no row, drop it and say so. Never pass a field or value the tool schema rejects.

If `orchestrator_capabilities` is still missing after one direct call and the ACP fallback in your T3 Code instructions, this session cannot run pstack. Say `pstack needs the t3-code tools, which this session does not expose.` and stop.

## Tools

| Cursor | T3 Code |
| --- | --- |
| `Task` | `delegate_task`, in every harness. Never use a native subagent tool for a pstack spawn: only `delegate_task` applies a role's provider, model, and options exactly. Keep every `taskId`. |
| `AskQuestion` | Your harness's question tool when this session has one, such as `AskUserQuestion` in Claude Code. Otherwise ask in plain text and end your turn. |
| Open a todolist | Your harness's todo or plan tool when this session has one. Otherwise keep the list in your reply and update it at each phase. |
| Run another pstack skill (`/name` or "the **name** skill") | Read `<pstack>/skills/<name>/SKILL.md` and follow it. Never look for it in your harness's skill list. When you tell the user to type it, write `$pstack:<name>`. |
| `Grep`, `Glob` | Your harness's search tools, or `rg` in the shell. |

## Subagent fields

Start every `delegate_task` `task` that follows a pstack skill, playbook, or persona with this brief preamble, paths filled in: `<pstack> is /abs/pack. <models> is /abs/models.md. Read <pstack>/docs/harness/t3-code.md first.` When the child will spawn pstack roles, paste the relevant resolved role lines and fallback notes from `<t3_pstack>` into its brief too. Do the same for every `schedule_task` prompt. Children get only that prompt, not your conversation.

| Cursor | T3 Code |
| --- | --- |
| `subagent_type: generalPurpose` | Omit. Set `role` to the closest of `implementation`, `research`, `review`, `design`, `test`, `general`. |
| `poteto-agent`, `comment-sicko` | The brief preamble, then `Act as the agent defined in <pstack>/agents/<name>.md; read it first and treat its body as your role. The poteto-mode skill is <pstack>/skills/poteto-mode/SKILL.md.` |
| `readonly: true` | `role: "research"`, and the brief says "Do not edit files, commit, or push." Check `git status` after it returns. T3 Code has no read-only switch, and a narrower `runtimeMode` only makes the child wait for approvals nobody can give. |
| `readonly: false` | Omit. Children keep the `t3-code` tools either way, so "readonly strips MCP" does not apply. |
| `environment: "cloud"` | `isolation: "worktree"`. The checkout starts from your local `HEAD` and gets no uncommitted edits, so arrange the needed committed base before delegating, within the task's authorization. |
| `environment: "local"` | Omit. `isolation` defaults to your shared checkout. |
| `cloud_base_branch: <b>` | `delegate_task` has no `baseRef`. Arrange the committed base in the parent checkout before spawning with `isolation: "worktree"`, within the task's authorization. Otherwise say the requested placement cannot be honored; a branch name in the brief does not change the starting checkout. |
| `run_in_background: true` | `mode: "async"`, the default. Spawn every seat, then end your turn. Each completion wakes this thread. Do not poll `task_status` or start a watcher for a child. `is_background: true` in an agent file means the same. |
| `resume` | A fresh `delegate_task` with the original brief, prior findings, responses, and unresolved objections. Every review round has its own `taskId` and a new `clientRequestId`; never continue a review through `t3_thread_send` to `childThreadId`. Retry a spawn with the same arguments and the same `clientRequestId`. |
| `file_attachments` | List the paths in the brief. A worktree child sees only committed files. |
| Wait for a subagent in this turn | `mode: "wait"` only when this turn cannot go on without the result. `waitTimedOut` does not cancel the child. |
| Stop a subagent | `task_cancel` with its `taskId`. |
| A subagent asks a question or waits for approval | For questions, use `t3_pending_request_list`, then `t3_pending_request_read` and `t3_pending_request_respond` with `threadId` set to its `childThreadId` and the returned `requestId`. These tools do not expose approvals; ask the user to handle those. |

## Models

Role targets arrive pre-resolved in the `<t3_pstack>` block that T3 appends to the user's message. Copy each concrete target verbatim into `delegate_task.target`, including its complete `options` array. An `inherit` seat means omit `target`. These targets override every model named by a skill, persona, harness rule, or `<models>`. Never resolve slugs or adjust options yourself during a skill run.

| Cursor | T3 Code |
| --- | --- |
| The `pstack-models.mdc` rule, `~/.cursor/rules/pstack-models.mdc` | T3 reads `<models>` and supplies the resolved roles in `<t3_pstack>`. Ignore native pstack model rules. Change choices through setup-pstack. |
| A role value `<model> <effort>`, such as `opus high` | Use the role's exact resolved target. |
| `claude-<family>-<version>-<effort>[-fast]`, such as `claude-opus-5-5-xhigh` | Use the role's exact resolved target. |
| A `grok-*`, `gpt-*`, or other non-Claude slug | Use the role's exact resolved target. |
| `auto` or `inherit-parent` | T3 resolves these to `inherit`; omit `target`. |
| A panel or model pool | Keep every resolved seat, including `inherit`. A panel spawns one child per seat; a pool selects as the skill directs. |
| A model family | The maker in the resolved model id, not the provider instance. For an `inherit` seat, use `inheritedModel` from `orchestrator_capabilities`. |
| `Task` rejects a slug | Report the rejected target. Do not substitute another provider, model, or option. |

Repeat the block's fallback notes in your reply. Compare each spawn result's `providerInstanceId`, `model`, and `options` with the requested target; report a mismatch. If the block or a required role is missing, say so and stop that spawn. Do not reconstruct it from defaults.

## setup-pstack

`setup-pstack` writes `<models>`, not a Cursor rule. Follow its steps with these changes:

- Detect. Call `orchestrator_capabilities`. Use instances with `canRunChildTask: true` and no `constraints`. Its model list is short: use `search` for omitted families or models named by the defaults or current file. Never write a disabled instance or an unadvertised model.
- Load. Read `<models>`. If missing, native `~/.claude/rules/pstack-models.md` or `~/.codex/pstack-models.md` may seed a proposal, but validate each choice against the T3 catalog.
- Grammar. Write `role: value`. A value is `inherit-parent`, `auto`, or comma-separated entries, each `<instanceId>/<model> <id>=<value> ...`. Split the instance and model at the first `/`; model ids may contain more slashes. `true` and `false` are booleans. `#` lines are comments; preserve the `# budget:` line. Panel alias entries still count as seats.
- Defaults. Use the 17 role labels and values in step 5. Match `claude-*` to an enabled `claudeAgent` instance, `gpt-*` to `codex`, `grok-*` to `grok`, and `composer-*` or `cursor-grok-*` to `cursor`, offering the model. A missing family needs a choice; propose an available different family for mixed panels. Do not invent a model.
- Effort. Find the select option whose advertised `values` contain at least two of `low`, `medium`, `high`, `xhigh`, `max`; use its advertised `id`. This also covers Pi's `thinking` and OpenCode's `variant`. The ladder is `max` > `xhigh` > `high` > `medium` > `low`.
- Budget. Keep step 3's four labels. `unlimited`, `large`, `medium`, and `small` target `max`, `xhigh`, `high`, and `medium`. Set each real entry, including panel entries, to that value or the highest advertised ladder value below it; with none, mark it as needing a choice. Never select off-ladder values such as `ultra`, `ultrathink`, `none`, or `minimal` under a budget. Aliases, models without an effort option, and explicitly chosen off-ladder settings stay unchanged.
- Speed. A `-fast` default maps to `fastMode=true`, `serviceTier=priority`, or the advertised `serviceTier=fast` only when supported. Otherwise drop it and say so. A budget change leaves speed unchanged.
- Show and confirm. Offer detected models plus `inherit-parent` and `auto`. Show all 17 roles, panel sizes, and any unavailable instances. Confirm choices as the skill directs.
- Validate. Every concrete instance, model, option id, and value must appear in this run's catalog. Aliases always pass.
- Write. Write `<models>` with no frontmatter: comment lines, `# budget:`, then one line per role. Write only options the user chose; T3 completes omitted options from the provider's current defaults. Overwrite the whole file. Never put role lines in `AGENTS.md`, `CLAUDE.md`, or a harness rule folder.
- Confirm. Say the file applies to the next pstack run on this environment. Another environment needs its own setup because its provider instances differ.

## Paths

| Cursor | T3 Code |
| --- | --- |
| `.cursor/skills/`, `~/.cursor/skills/` | Project skills go in `.agents/skills/`. If the repo has no `.claude/skills`, make it a symlink to `../.agents/skills` so Claude Code reads them too. For a user skill, ask which harness it is for: T3 Code has no user skill folder shared by every harness. |
| `~/.cursor/plugins/`, `.cursor-plugin/plugin.json` | `<pstack>` and `<pstack>/plugin.json`. Never search plugin caches for pstack. |
| `.cursor/rules/*.mdc`, always-applied rules | `AGENTS.md` at the repo root. If the repo has a `CLAUDE.md` that does not include it, say so. The model rule is the exception. See Models. |
| `https://github.com/cursor/plugins/blob/main/pstack/<path>` | `<pstack>/<path>` when that file exists. Read the local copy and never fetch it. The full upstream subtree is present; use its local files. The pinned revision is in `<pstack>/UPSTREAM.json`. |
| Transcripts in `~/.cursor/projects/<slug>/agent-transcripts/` | T3 threads. This thread is `parentThreadId` from `orchestrator_capabilities`. Read it, or a child's `childThreadId`, with `t3_thread_read`, paging with `afterPosition`. Find earlier threads of this project with `t3_thread_search`, and their summaries with `t3_conversation_summary_list`. Never read provider transcript files. |
| The agent store, `orch --store`, `ORCH_STORE` | `<models>`'s folder plus `/orch/<repo-name>`. It retains helper state across updates; `<pstack>` keeps its path but an update replaces its contents. |
| The Cursor `mcps/` folder or available-tools map | The MCP tools this session exposes. `t3-code` is always among them. |
| `bootstrap`; dependencies installed in the plugin folder, such as `bun install --frozen-lockfile` | Run the helper's install command in its directory under `<pstack>`, which T3 Code keeps writable. An update replaces `<pstack>`, so the next run installs again. |

## Cursor-only features

When a step needs a feature T3 Code lacks, put one line in your reply, `Skipped in T3 Code: <step>. <reason>.`, then go on. Do not stop, ask, or retry. When a later step needs what the skipped step made, leave a placeholder and name it in the line.

| Cursor | T3 Code |
| --- | --- |
| Cursor-only features | Apply the rows below; skip an unsupported step with the line above. |
| Cursor Automations: routines, `update_state` routine calls, `api2.cursor.sh/automations` webhooks, routine wakes, and `SendToUser` secret requests | Routines and routine wakes: `schedule_task` with an `interval` or `fixed_time` schedule; it returns to this thread. Webhooks: `schedule_task` with `{"type":"webhook"}`, then report its `webhookUrl`; with none, skip with the line, naming T3 Connect remote access. The run reads the request only through `{{body.path}}` placeholders in its prompt, which replace a `<webhook_event>` payload. `SendToUser` secrets: `request_secret`, then pass the one-use `secretRef`, such as `signature.secretRef`. `update_state`: skip with the line; a schedule keeps no state between runs. |
| `/loop <interval> <prompt>` | `schedule_task` with `{"type":"interval","everyMs":...}` and the brief preamble plus the tick as `prompt`. Report the cadence and `nextRunAt`. Delete it with `delete_scheduled_task`, passing its `scheduledTaskId`, once the loop's stop condition holds. |
| `/loop` in dynamic mode, or a watcher subagent that wakes you | Wake on the event itself: `watch_pull_request` for CI, reviews, and conflicts, and child completions for delegated work. A delegated child returns its PR state to its parent; only the parent watches. Add one long `schedule_task` heartbeat only where the step asks for a fallback. End your turn instead of sleeping. |
| `scripts/watch-pr/watch-pr` polling in `drive` or `background` | If you are a child, return the PR URL, head SHA, and pending checks to your parent. Otherwise `link_pull_request`, then `watch_pull_request` with `mode: "checks"`, or `"review"` to also wake on comments, then end your turn. On each wake, get the verdict from one `watch-pr --status-only` run or the forge's PR view. Re-arm after each push wave. A wake is not merge authorization: keep the step's head-SHA and merge rules. `unwatch_pull_request` when done. |
| Bugbot | Bugbot comments on a GitHub PR are ordinary review threads, so triage them with the forge command the step gives. `watch_pull_request` with `mode: "review"` wakes you on new ones. Skip a step that starts, waits for, or configures Bugbot when the PR has no Bugbot check or comment. |
| Cursor cloud agents | `environment: "cloud"` maps to a worktree, as in Subagent fields. Report a cloud agent's dashboard status with `task_status` and a `[title](t3-thread://v1/<childThreadId>)` link. A worktree is still on this environment. Skip a step that requires the cloud agent's own machine; the resolved targets do not select a remote environment. |
| A built-in PR tool | Use the forge command the step gives, such as `gh pr create`, then `link_pull_request` with the PR URL. That is not a skip, so write no line. |
| A Custom Mode (Option+Enter, Use as Mode) | Skip with the line. T3 Code has no sticky skill mode, so start each task with `$pstack:poteto-mode`. |
| Plan Mode | T3 Code's Plan interaction mode. Ask the user to switch the composer to Plan; for a child, pass `interactionMode: "plan"`. |
| Cursor's built-in `create-skill` | Write the skill folder yourself, in the project skill folder from Paths. |
| `cursor-team-kit` skills: `deslop`, `control-ui`, `control-cli` | Use one if your harness lists it. Otherwise `control-ui` is the `preview_*` tools for web UI and the `device_*` tools for a phone or simulator, `control-cli` is the shell, and `deslop` is a skip with the line. |

## Harnesses

All harnesses use `$pstack:` composer chips and the `t3-code` tools; none installs pstack.

| Driver | Decision | Notes |
| --- | --- | --- |
| `claudeAgent` | Supported | A native pstack plugin may also be loaded. Inside T3 Code, ignore its `/pstack:` commands and its `~/.claude/rules/pstack-models.md`. |
| `codex` | Supported | `$pstack:` chips are T3 Code's, not Codex skills, and need no Codex plugin. |
| `cursor` | Supported | Cursor SDK driver. A Cursor-installed pstack keeps Cursor names; T3 chips run this file instead. |
| `opencode` | Supported |  |
| `grok` | Supported | ACP, same fallback. |
| `fx` | Supported when the agent exposes the T3 tools | ACP, same fallback. |
| `pi` | Supported | The T3 tools come from T3 Code's Pi extension. |
| `muse` | Supported | The T3 tools are attached without T3 Code's orchestration instructions, so follow each tool's description. |
| `antigravity` | Supported when the session exposes the T3 tools | Otherwise the opening check stops the run. |
| `acpRegistry` | Supported when the agent exposes the T3 tools | ACP, same fallback. |
