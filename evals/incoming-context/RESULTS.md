# Local evaluation checkpoints

These recorded checkpoints precede the current `causal-context-v2` and
`selection-evidence-v3` repairs. Current case timing also includes source loading
and context reconstruction. Coverage, savings and latency have not been rerun
under the combined rules; the figures below describe the named historical
checkpoints, not validation of the current evaluator.

## Recorded v3 protection-policy checkpoint

Development experiment; no candidate is approved for live pruning.

### What this revision adds

Retention that runs before any question, with an explicit reason per block:

- **Complete JSON object/array spans.** A stdlib `json.JSONDecoder.raw_decode` is attempted only
  at standalone container starts (line start, or after `=`/`:`/`>`/`|`); scanning resumes after
  each decoded value. Scalars are never containers, and inline argument brackets
  (`execve(..., ["/a"], 0x..)`) are not starts. Every block a container spans on one text leaf
  is kept, with the span recorded in that block's coordinates. A JSON-shaped start that fails to
  decode keeps its whole leaf when it opens the leaf, and only its own block when it is mid-text.
  Nothing is retained because text merely looks like an audit or a schema.
- **Requested source.** Exactly one file must resolve from the originating call (single
  `path`/`file_path`/`file`, or a one-operand `cat`/`bat`/`nl`/`head`/`tail` with no composition)
  _and_ be named by a sourced instruction with a read/review intent. Every unresolved shape
  abstains from the claim instead of guessing.
- **No question about a retained block.** Hard-kept and protected blocks are never sent, so an
  unscored block records `p_keep: null`, `proposed: null`, `hard_keep: true`, and no usage. A
  `null` proposal is the absence of a decision, not a keep; `effective` remains the only field
  that states what happened. With no eligible block left, nothing is sent.
- **Protection identity.** Results record `POLICY_VERSION` (`selection-evidence-v2`) and
  `PROTECTION_VERSION` (`json-span-v2+evidence+source-v1`). `sweep`/`rerender` reuse a frozen
  result's hard-keep records only when its protection identity is current; anything else is
  reported `protection_current: false` and keeps its original output at every threshold. Frozen
  v1/v2 artifacts therefore yield 0 % when rethresholded instead of silently inheriting rules
  they were never measured with.
- **Accounting.** Totals partition blocks into protected / hard-kept (structure, evidence,
  source) / context-abstained / eligible; they also count eligible tokens, questions actually
  asked against eligible blocks, every scoring attempt including failures, and the protected
  share of tokens.

### Development regressions (this sample is consumed)

Both datasets below were already used to develop v2, so they are regression checks, not fresh
evidence. Same prompts (`keep-prompt-v2`), same thresholds, same batching, same local weights.

| Corpus              | Config     | Net saved | Dropped / proposed | Scored | Asked questions | Calls | Case p50 |    p95 |
| ------------------- | ---------- | --------: | -----------------: | -----: | --------------: | ----: | -------: | -----: |
| dev40 v2 (frozen)   | d1-3B 0.25 |       0 % |                0/2 |     73 |              73 |     6 |   5.4 ms | 3.60 s |
| dev40 v3            | d1-3B 0.25 |       0 % |                0/0 |     58 |              58 |     5 |   5.3 ms | 2.76 s |
| dev40 v2 (frozen)   | pplx 0.10  |   11.03 % |              48/48 |     73 |              73 |     6 |   5.3 ms | 7.94 s |
| dev40 v3            | pplx 0.10  |   10.71 % |              47/47 |     58 |              58 |     5 |   5.3 ms | 5.57 s |
| holdout v2 (frozen) | d1-3B 0.25 |       0 % |                0/0 |     11 |              11 |     4 |   0.53 s | 3.51 s |
| holdout v3          | d1-3B 0.25 |       0 % |                0/0 |      8 |               8 |     2 |   8.2 ms | 3.03 s |
| holdout v2 (frozen) | pplx 0.10  |    3.67 % |                3/4 |     11 |              11 |     4 |   0.95 s | 6.77 s |
| holdout v3          | pplx 0.10  |    3.67 % |                3/3 |      8 |               8 |     2 |   8.9 ms | 5.61 s |

Reading it: the protection removes 15 of 73 questions on dev40 and 3 of 11 on the holdout.
pplx dev40 savings decrease from 11.03% to 10.71%; holdout savings remain unchanged.
The holdout proposal retained by requested evidence is now never asked, which is why
4/3 becomes 3/3 with the same removed blocks. d1 still
proposes nothing at 0.25: its only dev40 proposals were evidence blocks, and evidence blocks are
no longer scored.

The decisive holdout case is unchanged. v3 removes exactly the same blocks (8, 9, 12 of 53) as
v2, including the two the root judged a major source-evidence loss. Structural retention did not
touch them (they are Rust source, not JSON) and requested-source abstained on the call shape, so
**this revision does not fix that regression class**; it makes the policy narrower and cheaper and
the bookkeeping honest, not safer on that case.

### Requested source: implemented but inert on this workload

Every originating call in the measured corpora is a harness wrapper around composed commands
(`text(await tools.exec_command({cmd: "..."})); text(await tools.exec_command({cmd: "..."}))`),
often with several commands per call. No exact single-file selection can be proven from that
shape, and mapping blocks back to one command is impossible because the outputs are concatenated.
The rule therefore made **0 claims** (`requested_source_blocks = 0`) on dev40, the previous
holdout and the fresh set. It is covered by synthetic tests; it is not evidence on real calls. A
provider call shape that exposes a single file read would be needed before this rule can help,
and the alternative — a broad regex over command text — was rejected deliberately.

<!-- FRESH-CACHE -->

### Fresh, never-measured checkpoints (not a holdout)

The untouched `test` split has no unused checkpoint with verified causal context: of its 24
unused checkpoints, 16 abstain as `goal_ambiguous:compacted_history` and 8 as
`goal_missing:no_human_instruction`, and an abstained checkpoint sends no request. The previous
holdout consumed every context-available test checkpoint. Rather than reuse one, selection moved
to **unused sessions of the development split**: 23 sessions / 92 checkpoints were never
measured by any prior artifact, 16 have verified context and 8 of those have eligible blocks. The
rule and the case file were frozen before any v3 score existed (`runs/evidence-v3/freeze.json`):

```
fresh-cases.json      sha256 073475037d9c2431558745f81fe87672b33b879b7b10eed9adde3c119b8c9c2e
fresh-manifest.json   sha256 8a085345dd64886ec49e19a3212f0f93d8ef128fa57cbf8341510ba7e6aabbe9
```

8 checkpoints from 8 sessions, 50,891 tokens, 139 blocks, 68 eligible, 3 mixed JSON + trace, one
with no hard-kept block at all. Rule: prefer mixed JSON+trace, then most eligible blocks, at most
one checkpoint per session, then size extremes.

| Configuration                 | Net saved | Dropped / proposed | Asked | Calls | Evidence kept | Structural kept | Case p50 |     p95 |
| ----------------------------- | --------: | -----------------: | ----: | ----: | ------------: | --------------: | -------: | ------: |
| Keep original (control)       |       0 % |                0/0 |     0 |     0 |             6 |               3 |   5.2 ms | 14.0 ms |
| Exact duplicate (control)     |       0 % |                0/0 |     0 |     0 |             6 |               3 |   5.1 ms | 14.0 ms |
| d1-3B, 0.25                   |    5.43 % |                8/8 |    72 |     8 |             6 |               3 |    9.8 s |  19.3 s |
| pplx-decider-flash-v1.2, 0.10 |    5.46 % |                7/7 |    72 |     8 |             6 |               3 |   11.5 s |  18.6 s |

The recorded census lists 68 eligible blocks while this table lists 72 asked questions.
That discrepancy has not been reconciled against the private run artifacts; these counts
must not be treated as a validated coverage measurement.

Three of the eight cases lose content (one under d1, two different ones under pplx); the other
five keep everything, so this set does show positive removals next to keep-all behaviour. The
largest removal is 9,180 → 8,072 tokens. No request failed and none was refused as oversize.

This is a **fresh development sample**, not a holdout and not an estimate of production savings:
it was selected partly for structural contrast, the sessions are development-split, and eight
checkpoints cannot bound risk.

### Bounded cache-option comparison (d1 only)

The installed runtime documents `prefix_cache_gb` for d1, Clef, Base Labs and H2O-Lightning, so
one case (17,922 tokens, two requests) was run on d1 with the option on and off, twice each, and
nothing else changed:

| `prefix_cache_gb` |        case total |         request 1 |           request 2 | decisions  |
| ----------------- | ----------------: | ----------------: | ------------------: | ---------- |
| 0 (off)           | 28.61 s / 28.69 s | 15.30 s / 15.39 s |   13.23 s / 13.23 s | `e3a29f6d` |
| 2.0 (default)     | 17.26 s / 17.24 s | 15.35 s / 15.31 s | **1.84 s / 1.87 s** | `e3a29f6d` |

The second request reuses the first request's state prefix, so the same work is 7× faster; the
case total drops by 40 %. Decisions are byte-identical (`after_sha256`), and the historical
prefix is unchanged in every run (`prefix_bytes` 411,147 with the same `prefix_sha256`). Cache
reuse is therefore a runtime property only, never a selection rule. pplx does not accept the
option: the receipt records `load_options_refused: [noul_floor, prefix_cache_gb]` and it was not
forced. No cache layer was invented.

### Blind packet for this revision

`blind-evidence-v3/` (local scratch) holds three anonymous packets built from these runs:

- `packet/` — the three fresh cases that actually lose content (one under d1, two others under
  pplx), 3 cases × 4 labels = 12 labels, removed block range 0–8;
- `fresh-intact/` — three fresh cases where nothing is removed, 12 labels, so a reviewer can
  check that controls are intact;
- `dev40/packet/` — the single large development case that carries the whole dev40 saving, 4 labels.

No candidate identity, model, score, threshold, latency or savings total is in a packet; the
identity maps were written by the builder and have not been opened. Root owns the judgments.

### Accounting on dev40 under the final policy

Blocks partition exactly: 204 protected + 15 hard-kept (2 structural, 13 requested evidence) +
106 context-abstained + 58 eligible = 383. The selector was asked 58 questions in 5 calls, so
`unasked_eligible_questions` is 0 and `eligible_blocks - asked_questions` can never be negative.
`failed_blocks` is 0, not the 106 that a naive "abstain" count reports, because context
abstention is a policy keep rather than an inference failure; `failed_requests` is also 0, and
`actual_calls` matches `completed_requests` plus failures. Every unscored block has
`p_keep: null`, `proposed: null` and no usage, so a guard can never be read as a model keep.

### Decision and next gate

Do not promote either candidate. This revision makes retention narrower, cheaper and
auditable; it does not make the known failure class safe:

- the holdout case that the root judged a major source-evidence loss still loses exactly the same
  three blocks, because the requested-source rule cannot resolve the real call shape;
- dev40 savings still come from one large result, and the fresh sample has only eight selected
  checkpoints, so these figures describe workloads rather than a validated policy;
- the fresh sample is development-split and selected, not a holdout.

Before promotion: a provider call shape that exposes a single file read (so requested-source can
fire), a provider-owned interception point, and context-available held-out sessions that were
never inspected. The structural rule is the only part of this revision that changes decisions on
real data, and it changes 2 of 383 dev40 blocks and 0 of 83 holdout blocks.

## Prior checkpoint: repaired full-result state (v2)

Development experiment; neither configuration is approved for live pruning.

### What this revision repairs

The previous evaluator showed the selector only the blocks it was currently asking about. It asked
about a group at a time but built each request's state from that group alone, and the group excluded
protected blocks. A protected sibling (boundary or diagnostic) was therefore invisible to the model
judging a neighbouring block, and blocks questioned in another request were invisible in this one.
The docstring claimed the state carried the whole pending result; it did not.

Two further defects were found while repairing it, both in the selector contract rather than the
state:

- The prompt said to answer "no" when the retained result already shows the block's content, but
  the selector only ever sees the full original result. Nothing guarantees a sibling is kept, so
  joint drops could erase every copy of a fact. The shipped prompt now answers per block and states
  that no sibling is a witness. No dependency-group or witness machinery was added.
- The batch budget was charged an estimate of the target blocks, not the request that is actually
  sent. It now measures the complete serialized request — state plus that group's questions —
  and abstains when even one question exceeds the budget instead of repeating an oversized state
  once per block.

A separate audit of the causal context answered the other half of the question: the source never
contributes assistant content, so no assistant plan or task-progress state exists and none is
supplied. `causal_context` collects every readable `user` message before the checkpoint (1 to 6 per
scored development case, all with `human` provenance) plus the full originating call, and refuses
harness envelopes or developer-role messages rather than promoting them. A summary layer would add a
new failure mode, not recover missing state. See [README.md](README.md#what-the-selector-sees).

Every measured result records `request_version`, `state_version`, `prompt_version` and the prompt
digest at the top level and inside each case receipt. A run reports `request_version` only when every
case carries the run's own identity; `rerender`/`sweep` carry the input's version through. Frozen v1
scores therefore stay labeled v1.

## Separating the state change from the prompt change

State and prompt changed together, so the two effects are not identified from a single before/after.
The evaluator keeps both prompt texts (`--prompt v1|v2`) to measure them separately. The subset is
the 5 development cases that have verified context and at least one unprotected block — the only
cases where a selector runs — and every cell below uses the same cases, thresholds (d1 0.25,
pplx 0.10), and model settings. The frozen v1 run used an 8,000-token target-based batch budget; v2 uses a 32,000-token complete-request budget. Grouping and visible state therefore differ across the frozen-state comparison. Only the two v2-state prompt cells share the new budgeting contract.

| Cell (37,637 tokens, 73 unprotected blocks) | d1 drops / proposed | d1 saved | pplx drops / proposed | pplx saved |
| ------------------------------------------- | ------------------: | -------: | --------------------: | ---------: |
| v1 prompt + v1 target-only state (frozen)   |               47/49 |   39.66% |                 37/37 |     31.13% |
| v1 prompt + v2 full-result state            |               43/49 |   39.26% |                 46/46 |     38.83% |
| v2 prompt + v2 full-result state (shipped)  |                 0/2 |       0% |                 48/48 |     40.43% |

Reading it: at a fixed old prompt the state change alone leaves d1 removing almost as much (47 → 43
blocks) and moves pplx up (37 → 46). The prompt change is what collapses d1's removals (43 → 0, both
remaining proposals retained as requested evidence) and nudges pplx further (46 → 48). The whole prompt revision is associated with d1 retaining more; the experiment does not isolate which clause caused it.
These are observational cells with a small sample: they bound the confound, they do not establish
causal effects, and the shipped rows are the only ones that describe the current contract.

## Development sample under the shipped contract

40 checkpoints from 40 private sessions, 137,982 tokens, 383 blocks (179 unprotected), 29 cases
abstaining for missing causal context, 204 protected blocks. Local MLX inference, no hosted selector
or judge.

| Configuration                 | Net tokens saved | Case p50 | p95 latency | Cases with removals | Dropped / proposed |
| ----------------------------- | ---------------: | -------: | ----------: | ------------------: | -----------------: |
| Keep original (control)       |               0% |   5.7 ms |     12.7 ms |                   0 |                0/0 |
| Exact duplicate (control)     |               0% |   5.9 ms |     12.5 ms |                   0 |                0/0 |
| d1-3B, 0.25                   |               0% |   5.4 ms |   3596.2 ms |                   0 |                0/2 |
| pplx-decider-flash-v1.2, 0.10 |           11.03% |   5.3 ms |   7941.4 ms |                   1 |              48/48 |

d1 proposed two removals and the requested-evidence guard retained both, so it saved nothing. pplx
removed 48 of 49 scored blocks in the single 17,922-token case, leaving 2,706 tokens; that one case
is the entire saving. Coverage is 73 of 179 unprotected blocks scored, 0 oversize refusals and 0
failed requests.

Per-request payload (identical for both candidates because grouping depends only on the config):
6 requests, 74,569 whole-request tokens, largest 24,461; block latency p50 477.7 ms (d1) and
1020.3 ms (pplx). The 17.9k-token case costs 17.4 s (d1) and 62.1 s (pplx), and pplx's p99 case
latency is 42.5 s.

For reference, the rejected checkpoint measured 10.82% (d1) and 8.49% (pplx) at the same thresholds
with a target-only state and the older prompt text. That comparison mixes both changes and is not a
measure of the state repair; the subset table above is the one to read.

## Fresh holdout

Selection was frozen before any holdout score was read (`select_holdout.py`, rule in the file), and
the run configuration was frozen with it (`runs/state-v2/config.frozen.txt` and `run_all.sh`): `split
== test`, sessions disjoint from the development subset every prior scored run used (0 of 17 test
sessions overlap), every context-available case with at least one unprotected block, the two
abstention cases with the most unprotected blocks, then the smallest and largest zero-target cases.
Result: 8 cases from 5 sessions, 35,342 tokens, 83 blocks (46 unprotected, 37 protected). Two cases
(33 of the 46 unprotected blocks) abstain for missing causal context and stay in the totals.

| Configuration                 | Net saved | Dropped / proposed | Evidence-retained | Case p50 |     p95 |
| ----------------------------- | --------: | -----------------: | ----------------: | -------: | ------: |
| Keep original                 |        0% |                0/0 |                 0 |   5.0 ms | 14.4 ms |
| Exact duplicate               |        0% |                0/0 |                 0 |   4.7 ms | 14.2 ms |
| d1-3B, 0.25                   |        0% |                0/0 |                 0 | 531.4 ms |  3.51 s |
| pplx-decider-flash-v1.2, 0.10 |     3.67% |                3/4 |                 1 | 951.6 ms |  6.77 s |

11 of 46 unprotected blocks received model scores (4 requests, 16,935 request tokens, largest 7,224). Two additional blocks were retained by evidence constraints, and 33 blocks belong to the two abstained cases. pplx removed 3 blocks from one 5,368-token case and
one more proposal was retained as requested evidence; d1 proposed nothing. The holdout is far too
small to estimate performance, and 3.67% of 35,342 tokens is three blocks, not a result.

Disclosure on sequence: the holdout was first executed with the earlier prompt text, before the
review identified the redundancy clause as a defect; that execution removed nothing for either
candidate. The prompt fix is an instruction-contract correction, decided without inspecting holdout
scores, and the holdout was rerun with the frozen selection and model settings. The frozen v1 run used an 8,000-token target-based batch budget; v2 uses a 32,000-token complete-request budget. Grouping and visible state therefore differ across the frozen-state comparison. Only the two v2-state prompt cells share the new budgeting contract. Only the shipped-contract
artifact is retained, and the earlier aggregate is recorded here rather than in a file.

## Prior blind review (v1 contract)

Root reviewed six anonymous development cases under the earlier contract, saved judgments before
opening the identity map, then unblinded. Three cases had removals; two abstained for unavailable
context. d1 lost graph ordering, host/native closure, environment precedence and relevant tests from
a file explicitly requested for source review, and separately removed executable-control outcomes and
bootstrap-scope records needed for a diagnostic report: two major losses. pplx retained the
structured diagnostic outcome, controls and primary failure while trimming repetitive C/C++ discovery
traces: acceptable for that report, medium confidence. Intact controls lost nothing.

Those judgments apply to the v1 contract and cannot be transferred: scores for the same blocks differ
under the shipped contract.

## Blind review for this revision

`blind-state-v2/` (local scratch) holds one anonymous development case with 4 labels — two candidates
and two controls — seed 20261105, restricted to removal-bearing cases because only one development
case still has an effective removal. One label removes 48 of 53 blocks; the others remove nothing.
No candidate identity, model, score, threshold, latency or total-savings figure is in the packet;
per-block token counts and per-label removed-block counts appear only as block geometry. Save
judgments before opening the identity map.

Root saved judgments before opening the identity map. The removal-bearing label lost the remaining executable-control outcomes and empty product-call audit needed for the report: major evidence loss. Its identity was inferable from previously disclosed aggregate behavior, so this is anonymous-text review, not an independent model-blind study. The retained labels lost no evidence.

Root also directly inspected the holdout's three removed blocks after seeing the model identity. One removed the serialization flag and serde skip/default behavior of a type explicitly named in the task; another removed relevant roundtrip test construction. This is a source-evidence failure, not validated 3.67% savings. This inspection was unblinded.

## Operational note

One intermediate pplx run failed a request with a transient Metal error
(`kIOGPUCommandBufferCallbackErrorImpactingInteractivity`) on the second request of the largest case.
The evaluator abstained those 17 blocks as `unavailable` and kept the original, which is the intended
behaviour, and the final artifacts contain no failed or oversize requests. GPU contention can
therefore turn a measurement into a partial abstention; artifacts are checked for
`failed_requests` before numbers are reported.

## Decision and next gate (v2 checkpoint)

Do not promote either candidate. The shipped contract is much more conservative for d1 and still
very aggressive for pplx on a single large result, which is exactly what the one-case blind packet
has to judge. The state repair was a real correctness fix with a modest decision effect once the
prompt is held fixed, and the combined prompt revision had a larger observed association with d1 retention. The experiment does not isolate individual prompt clauses.
Before any promotion: a policy that retains explicitly requested source and audit facts, then a new session holdout with more scoreable cases, and a provider-owned interception point. Savings figures here describe a workload, not
approved pruning.

Validation for the v2 checkpoint: 82 unittest behaviour tests passed, including actual request
counting on budget refusal and recomputed removal totals after rethresholding. The v3 checkpoint
supersedes it with 113 tests; the v2 artifacts are retained unchanged and are reported as stale by
`sweep`/`rerender`. Evaluator runtime changed; production integration did not. Private
transcripts, identity maps, labels, weights and raw result files remain outside the repository.

### Review corrections after the v3 measurements

The measured v3 artifacts above use `json-span-v2+evidence+source-v1`.
The current implementation uses `json-span-v3+evidence+source-v1`: it continues
past malformed mid-text containers to find later complete JSON, avoids growing
substring copies while scanning, and retains the entire leaf if JSON decoding
exhausts recursion. Local budget refusals no longer count as actual or failed
model calls. Existing v3 measurements have not been rerun under this revision;
protection-version checks intentionally reject reusing their scores as current.

The new `output_lines.py` prototype independently decodes one bare command-result
envelope, renders original line ranges, and reconstructs omissions from a
verified original digest. It preserves surrounding envelope text and is not yet
wired into selection. Unknown representations abstain. This establishes neither
selection quality nor production interception/cache behavior. That checkpoint passed 154 local unittest tests after review corrections.
