# Local incoming-context evaluation

Offline evaluation for removing text from a new tool result before a model first sees it. This does not enable production pruning or modify provider history.

## Run synthetic checks

```sh
cd evals/incoming-context
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -p 'test_*.py'
```

The Incoming Context Eval workflow runs these behavior tests on changes to this directory, without weights or model inference.

Local model inference additionally needs the Apple Silicon `mlx-decision` runtime and separately downloaded weights. Inspect `evaluate.py run --help` for model, batching, deadline and size options. HTTP inference accepts loopback endpoints only, bypasses environment proxies, and refuses redirects.

## What the selector sees

One scoring request is one contract. `REQUEST_VERSION` (`incoming-state-v2:keep-prompt-v2`) names the state and prompt. Comparisons also match the causal-context, selection-policy and protection versions. The current eligibility rules are `causal-context-v4`, `selection-evidence-v4` and `json-span-v3+evidence+source-v2`; results with older or missing identities are not current measurements. `rerender`/`sweep` preserve the input identities and never stamp newer ones.

- `state.recent_user_context` — every sourced human instruction strictly before the result, oldest first, verbatim. `causal_context` collects `message` records with role `user`, skips `assistant` and tool records entirely, and refuses harness envelopes, developer-role messages, opaque content and unknown wrappers instead of promoting them to instructions. Compacted history contributes only retained, client-authored user inputs that carry verified provenance; otherwise the case abstains for an ambiguous goal. Nothing is summarized. Generated handoff headers and historical replay wrappers make the goal ambiguous: omitted history cannot be replaced by generated text presented as a human instruction. Such cases retain their original output without scoring.
- `state.tool_call` — the resolved originating call: name plus full command or arguments body, never truncated.
- `state.candidate_tool_output.blocks` — every block of the pending result, including protected boundary and diagnostic blocks, each with a positional `index`, its text-leaf `path` and its exact text. Question batching groups questions only; a block is never hidden from the state because another request asks about it.
- `questions` — one `noul` question per **eligible** block, using one fixed prompt for both batching modes. A block is eligible only when it is neither a protected boundary/diagnostic block nor already retained by a protection rule. The prompt asks about one block at a time and states that no sibling is guaranteed to survive, so redundancy is never by itself a reason to drop; a later source review, a requested audit and negative evidence are named as reasons to keep.

There is no assistant plan, task-progress or conversation-summary field, because the source records never contribute assistant content to the goal and generating one would need inference the evaluator does not have. The available instructions and the full originating call are the whole causal state; adding a summary would be a new context schema with its own failure modes, and the defect this revision repairs did not require it.

Budgets are charged the real serialized request, including HTTP's model field. `--batch-tokens` measures the complete request — the full state plus that group's questions — and a question is added only while the whole request still fits. When even one question would exceed the budget the case abstains as `oversize` and nothing is sent: a state cannot be shrunk by regrouping, and a request is never shortened to fit it. `--max-tokens` is the transport's independent ceiling for the same request. A result that would expand never replaces the original, and `apply_incoming` re-checks that the historical prefix bytes are unchanged.

`--prompt v1|v2` selects the question text; `v1` exists only so the prompt change can be measured apart from the state change. The identity of the chosen text is in every receipt.

## Retention that happens before any question

Three rules can keep a block without asking a model. They only ever add retention, they are recorded per block with an explicit reason, and none of them is a saving:

- **`requested source`** — a fully recognized read selects a file named by a sourced read/review/audit instruction. Supported forms include read-like tools with one path, literal `exec_command` arguments, repeated `text(await tools.exec_command({...}))` calls, and read-only shell lists using `;` or `&&`. The shell subset accepts explicit file operands, `cd ... &&`, numeric `head`/`tail` limits and fixed `sed -n 'N,Mp'` ranges. If any selected file is requested, the entire result is kept: concatenated output is never attributed to individual commands. Dynamic JavaScript, unknown commands, mutation, pipes, redirects, substitutions and globs make no source-retention claim. The recorded experiments used the older single-file rule; this broader recognition has synthetic coverage but has not been measured against those private recordings.
- **`json_container`** — a complete JSON object or array decoded with the stdlib `json.JSONDecoder.raw_decode` at a _standalone_ start (line start, or after `=`/`:`/`>`/`|`). Scanning resumes after each decoded value, so JSONL and several printed values are all found. Scalars are never containers, and inline brackets in argument lists (`execve(..., ["/a"], 0x..)`) are not standalone starts. Every block the container spans on that text leaf is kept, with the span recorded in the block's own coordinates.
- **`json_container_unverified`** — a JSON-shaped start that cannot be decoded. A leaf that opens such a container keeps the whole leaf (a truncated document); a mid-text one keeps only the block that carries it. Code braces (`if (x) {`, `fn main() {`) are not JSON-shaped and never match.

Structural retention is a property of the bytes, not a judgement about semantics: nothing is inferred from text that merely looks like an audit or a schema. Requested evidence terms keep their earlier narrow behaviour.

Hard-kept and protected blocks are never sent to the selector, so their decision row carries `p_keep: null`, `proposed: null`, `hard_keep: true` and a `hard_reason`/`hard_source`. A `null` proposal is not a keep: `proposed` is only ever `drop`/`keep` for a block the model actually scored, and `effective` is the only field that says what happened. If no eligible block remains, nothing is sent and the original result is retained.

## Evaluate private recordings

Supply an analysis manifest containing `census.sessions` entries with `origin: "T3 Code"` and a local `path` to each rollout JSONL. Generate cases with `evaluate.py prepare --analysis analysis.json --out cases.json`. Pass `--cases cases.json` explicitly to subsequent commands. Keep source recordings, manifests, model weights, result files and blind packets outside Git.

Prepared cases pin the exact source record and all preceding bytes. Source reads revalidate those hashes even on cache hits, and a recording changed during evaluation is rejected. Legacy manifests lack the full-prefix hashes; their context is still reconstructed from the current source, and frozen scores cannot be reused after that context changes.

The evaluator reconstructs causal instructions and poll origins from records preceding each result. Missing or ambiguous context retains the whole result without a scoring request, including unreadable attachments or corrections, malformed history, partially sourced compaction and interactive stdin absent from the originating command. Named evidence adds retention constraints. These heuristics are conservative and do not prove semantic safety.

The scoring state represents text only. Results with hidden JSON-envelope metadata, nontext siblings, or unrepresented diagnostic fields retain their full output without inference. Deeply nested JSON that cannot be decoded also retains its text. Truncated responses, duplicate answer fields, and answer IDs that differ from the request are unusable. Case timing includes source loading, context reconstruction, rendering and accounting; HTTP timeouts are bounded by the remaining deadline, and an expired result is retained whole. MLX initialization failures abstain, and changing the model or load options reloads the runtime. These rules can reduce coverage and change timing compared with older measurements.

`run` records model input, scores, effective decisions, elapsed time, per-request state and request token counts, and local prefix receipts. Totals separate protected, hard-kept, context-abstained and eligible blocks and tokens, count questions actually asked against eligible blocks, and count every scoring attempt including failed ones. `sweep` and `rerender` derive new thresholds from frozen scores; guards count as zero effective drops. Threshold fitting with `equalize.py` accepts matching development cohorts only. Stability comparisons check source and context identity, and latency groups separate runtime and budget configurations. Changes to context, prompt, state or batching require fresh inference. `blind_packet.py` validates every candidate against the same source blocks and causal context, checks retained-output hashes, and randomizes candidate order independently for each case. Invalid or empty builds leave an existing review packet untouched. Save judgments before opening the separate identity map. Reviewer-only enrichment must not be represented as model input.

## Frozen results cannot inherit a newer policy

Every result records `request_version`, `state_version`, `prompt_version`, `policy_version` and `protection_version`. `sweep`/`rerender` reuse a frozen result's hard-keep records only when its context, selection-policy and protection identities are current. A result recorded under another policy (or before this version existed) is reported with `protection_current: false` and `stale_protection`, keeps its original output at every threshold, and reports no derived savings. Old artifacts are never rewritten and never silently upgraded: re-thresholding a v2 measurement cannot loan it the JSON or source rules it was not measured with.

## Current limits

Synthetic checks cover causal cutoffs, poll resolution, source changes, retention, failure paths, accounting, the whole-result state, request budgets, prefix invariance, version provenance, JSON span decoding, and literal composed reads. They cannot cover a real provider interception point or real provider cache hits. No model is approved for live pruning.

The recorded development sample contains 40 checkpoints; its prior context census abstained on 29. The measured protection policy had 15 hard-kept blocks (13 requested evidence, 2 structural), 58 eligible blocks and only one case with an effective removal. The sampled test split was exhausted, so the fresh sample used 8 never-measured development checkpoints and is **not** a holdout. `requested source` made no claim on real calls because their harness wrappers contain composed commands. These counts and measurements have not been rerun under the current eligibility rules. Private recordings and judgments remain outside Git and do not establish semantic safety.

### Experimental decoded-line adapter

`output_lines.decode(raw, producer)` accepts the explicitly identified bare
`t3.exec.v1` envelope with exactly one completed (`exit_code`) or running
(`session_id`) status form. `render(decoded, keep)` accepts half-open original
line ranges, coalesces omissions, and changes only the JSON output string token.
`omitted_text` verifies the original digest before recovering an omitted range.
No-op rendering preserves the original envelope exactly; unknown shapes abstain.
The producer identifier is a caller assertion, not inferred provenance.

This adapter is not connected to the decision engine or a live provider.
Markers identify a source digest and line range; a production retrieval service
and event locator are still required. Character counts are not token savings,
and the evaluator must enforce token non-expansion before applying any selection.

`line_experiment.py` provides offline `freeze`/`run`/`compare` and
`freeze-edits`/`run-edits`/`compare-edits` commands for per-line and complete-edit
experiments. Comparisons write JSON. Real transcript manifests and results stay
outside the repository. Complete-edit v2 preserves the full parent result, including headings and sibling
outputs, while replacing only the selected envelope text. Frozen plans bind parent
identity, leaf coordinates, required evidence, exact request serialization order,
and candidate token counts. Model approval is recorded separately from effective
acceptance; an expanding replacement is always rejected. Controls without verified
required lines are refused.

Frozen context, calls and request grouping are verified
before dispatch; the request cap is enforced before each call. Local MLX calls
have no enforced wall-clock timeout. Model-loading failures are recorded as
rejections, not omitted from the result.
