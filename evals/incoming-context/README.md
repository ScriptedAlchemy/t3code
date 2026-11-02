# Local incoming-context evaluation

Offline evaluation for removing text from a new tool result before a model first sees it. This does not enable production pruning or modify provider history.

## Run synthetic checks

```sh
cd evals/incoming-context
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -p 'test_*.py'
```

Local model inference additionally needs the Apple Silicon `mlx-decision` runtime and separately downloaded weights. Inspect `evaluate.py run --help` for model, batching, deadline and size options. HTTP inference accepts loopback endpoints only.

## Evaluate private recordings

Supply an analysis manifest containing `census.sessions` entries with `origin: "T3 Code"` and a local `path` to each rollout JSONL. Generate cases with `evaluate.py prepare --analysis analysis.json --out cases.json`. Pass `--cases cases.json` explicitly to subsequent commands. Keep source recordings, manifests, model weights, result files and blind packets outside Git.

The evaluator reconstructs causal instructions and poll origins from records preceding each result. Missing or ambiguous context retains the whole result without a scoring request. Named evidence adds retention constraints. These heuristics are conservative and do not prove semantic safety.

`run` records model input, scores, effective decisions, elapsed time and local prefix receipts. `sweep` and `rerender` derive new thresholds from frozen scores; guards count as zero effective drops. Changes to context, prompt or batching require fresh inference. `blind_packet.py` produces anonymous cases for a reviewer. Save judgments before opening the separate identity map. Reviewer-only enrichment must not be represented as model input.

## Current limits

Synthetic checks cover causal cutoffs, poll resolution, retention, failure paths, accounting and packet rendering. Local prefix fixtures do not prove provider cache hits or a supported native-tool interception point. Real-world blind review found necessary evidence lost in the earlier selector. The repaired selector still needs completed blind review. No model is approved for live pruning.

The development sample contains 40 checkpoints. The current context census permits scoring 11 and abstains on 29. Those abstentions remain in workload totals. Original measurements and private judgments remain local; they are not a public dataset or a completed validation of this revision.
