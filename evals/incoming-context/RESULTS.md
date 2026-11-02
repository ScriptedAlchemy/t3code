# Repaired local evaluation checkpoint

Development experiment; neither configuration is approved for live pruning.

## Measurements

40 checkpoints from 40 private sessions, 137,982 comparison tokens, local MLX inference. Context reconstruction allowed scoring in 11 cases and retained the original in 29 (21 ambiguous compacted histories, 8 missing human instructions). Boundary and diagnostic protection retained 204 of 383 blocks.

| Configuration                                         | Net incoming tokens saved | Workload p95 latency | Cases with removals |
| ----------------------------------------------------- | ------------------------: | -------------------: | ------------------: |
| Keep original                                         |                        0% |                13 ms |                   0 |
| Exact duplicate control                               |                        0% |                13 ms |                   0 |
| d1-3B, shared-state, threshold 0.25                   |                    10.82% |               2.60 s |                   3 |
| pplx-decider-flash-v1.2, shared-state, threshold 0.10 |                     8.49% |               5.23 s |                   1 |

Latency includes abstentions. The millisecond workload median mostly reflects cases where inference did not run; it must not be presented as selector speed. Measurements under system load are observations, not a guaranteed bound. The pplx run combines two processes; the first five-case segment lacks a runtime receipt, so configuration parity is incomplete. Tokens use o200k_base, not provider billing accounting.

## Manual blind review

Root reviewed six anonymous development cases (24 labels, including two controls per case), saved judgments before opening the identity map, then unblinded. Three cases had removals; two other cases abstained due to unavailable context. Aggregate measurements were already visible; this was not a fully isolated evaluator study. No hosted judge or downstream continuation was used.

- d1 removed graph ordering, host/native closure, environment precedence and relevant tests from a file explicitly requested for source review: major evidence loss.
- d1 removed executable-control outcomes and bootstrap-scope records needed for a diagnostic report: major evidence loss. A further telemetry removal was uncertain/minor.
- pplx retained the structured diagnostic outcome, controls and primary failure while trimming repetitive C/C++ discovery traces in one case. This removal was judged acceptable for that report, with medium confidence.
- Intact controls lost no evidence.

These are qualitative case judgments, not population error rates. One large result contributes about 80% of d1 gross removed-block tokens and all pplx removals. The sample does not establish general safety or repeatable savings.

## Decision and next gate

Reject the current d1 configuration for live pruning. Keep pplx as an experimental challenger only. Before expanding context coverage, test requested-source and structured-audit retention on new blind cases; tuning against these judged cases would be development work, requiring a fresh holdout. A real provider-owned interception point, retrievable omissions and actual cache behavior remain unproven by this offline evaluator.

Validation: 70 unittest behavior tests passed on the packaged evaluator; no runtime code changed for this checkpoint. Private transcripts, labels, identities, weights and raw result files remain outside the repository.
