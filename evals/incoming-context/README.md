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

Local model inference additionally needs the Apple Silicon `mlx-decision` runtime and separately downloaded weights. Inspect `evaluate.py run --help` for model, batching, deadline and size options. HTTP inference accepts loopback endpoints only.

## What the selector sees

One scoring request is one contract. `REQUEST_VERSION` (`incoming-state-v2:keep-prompt-v2`) names the state and prompt, and every result also records the causal-context and selection-policy versions. Comparisons must match all three: `request_version`, `context_version` and `policy_version`. The current eligibility rules are `causal-context-v2` and `selection-evidence-v2`; a frozen result with older or missing versions is not a current measurement. `rerender`/`sweep` carry the input's versions through and never stamp the current ones.

- `state.recent_user_context` — every sourced human instruction strictly before the result, oldest first, verbatim. `causal_context` collects `message` records with role `user`, skips `assistant` and tool records entirely, and refuses harness envelopes, developer-role messages, opaque content and unknown wrappers instead of promoting them to instructions. Compacted history contributes only retained, client-authored user inputs that carry verified provenance; otherwise the case abstains for an ambiguous goal. Nothing is summarized.
- `state.tool_call` — the resolved originating call: name plus full command or arguments body, never truncated.
- `state.candidate_tool_output.blocks` — every block of the pending result, including protected boundary and diagnostic blocks, each with a positional `index`, its text-leaf `path` and its exact text. Question batching groups questions only; a block is never hidden from the state because another request asks about it.
- `questions` — one `noul` question per scored block, using one fixed prompt for both batching modes. The prompt asks about one block at a time and states that no sibling is guaranteed to survive, so redundancy is never by itself a reason to drop; a later source review, a requested audit and negative evidence are named as reasons to keep.

There is no assistant plan, task-progress or conversation-summary field, because the source records never contribute assistant content to the goal and generating one would need inference the evaluator does not have. The available instructions and the full originating call are the whole causal state; adding a summary would be a new context schema with its own failure modes, and the defect this revision repairs did not require it.

Budgets are charged the real serialized request. `--batch-tokens` measures the complete request — the full state plus that group's questions — and a question is added only while the whole request still fits. When even one question would exceed the budget the case abstains as `oversize` and nothing is sent: a state cannot be shrunk by regrouping, and a request is never shortened to fit it. `--max-tokens` is the transport's independent ceiling for the same request. A result that would expand never replaces the original, and `apply_incoming` re-checks that the historical prefix bytes are unchanged.

`--prompt v1|v2` selects the question text; `v1` exists only so the prompt change can be measured apart from the state change. The identity of the chosen text is in every receipt.

## Evaluate private recordings

Supply an analysis manifest containing `census.sessions` entries with `origin: "T3 Code"` and a local `path` to each rollout JSONL. Generate cases with `evaluate.py prepare --analysis analysis.json --out cases.json`. Pass `--cases cases.json` explicitly to subsequent commands. Keep source recordings, manifests, model weights, result files and blind packets outside Git.

The evaluator reconstructs causal instructions and poll origins from records preceding each result. Missing or ambiguous context retains the whole result without a scoring request, including unreadable corrections after an otherwise readable goal and partially sourced compaction. Named evidence adds retention constraints. These heuristics are conservative and do not prove semantic safety.

The scoring state represents text only. Results with hidden JSON-envelope metadata, nontext siblings, or unrepresented diagnostic fields retain their full output without inference. A truncated HTTP response is likewise unusable, even when it contains valid scores. Case latency and the deadline include source loading and context reconstruction. These rules can reduce coverage and change timing compared with older measurements.

`run` records model input, scores, effective decisions, elapsed time, per-request state and request token counts, and local prefix receipts. `sweep` and `rerender` derive new thresholds from frozen scores; guards count as zero effective drops. Threshold fitting with `equalize.py` accepts development cases only. Changes to context, prompt, state or batching require fresh inference. `blind_packet.py` validates every candidate against the same source blocks and causal context, checks retained-output hashes, and randomizes candidate order independently for each case. Save judgments before opening the separate identity map. Reviewer-only enrichment must not be represented as model input.

## Current limits

Synthetic checks cover causal cutoffs, poll resolution, retention, failure paths, accounting, the whole-result state (protected and cross-group siblings, future-record exclusion), complete-request budget grouping and abstention, prefix invariance, prompt selection and request-version provenance. Local prefix fixtures do not prove provider cache hits or a supported native-tool interception point. Real-world blind review found necessary evidence lost in the earlier selector and in the earlier prompt text; both contracts have changed, so those judgments do not carry over. See [RESULTS.md](RESULTS.md) for measurements and limits. No model is approved for live pruning.

The recorded development sample contains 40 checkpoints. Its v1 context census permitted scoring 11 and abstained on 29. Those abstentions remain in the recorded workload totals, and only one development case had an effective removal. A holdout of 8 test-split cases (5 sessions, no session overlap with development) was also recorded, but only 11 of its 46 unprotected blocks were scoreable. These counts have not been recomputed under the current eligibility rules. Original measurements and private judgments remain local; they are not a public dataset or a completed validation of this revision.
