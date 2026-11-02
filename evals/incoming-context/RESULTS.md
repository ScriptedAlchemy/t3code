# Repaired local evaluation checkpoint (full-result state)

Development experiment; neither configuration is approved for live pruning.

## What this revision repairs

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

## Decision and next gate

Do not promote either candidate. The shipped contract is much more conservative for d1 and still
very aggressive for pplx on a single large result, which is exactly what the one-case blind packet
has to judge. The state repair was a real correctness fix with a modest decision effect once the
prompt is held fixed, and the combined prompt revision had a larger observed association with d1 retention. The experiment does not isolate individual prompt clauses.
Before any promotion: a policy that retains explicitly requested source and audit facts, then a new session holdout with more scoreable cases, and a provider-owned interception point. Savings figures here describe a workload, not
approved pruning.

Validation: 82 unittest behaviour tests pass, including actual request counting on budget refusal and recomputed removal totals after rethresholding. Evaluator runtime changed; production integration did not. Private transcripts, identity maps, labels, weights and raw result
files remain outside the repository.
