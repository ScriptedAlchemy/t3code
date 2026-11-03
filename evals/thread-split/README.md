# Thread independence evaluation

Tests whether a local decision model can identify a new message that needs none
of the preceding thread's results, files, decisions or instructions. A different
subject alone does not establish independence. This is an offline experiment;
it does not create threads, alter history, or display suggestions.

The direct prompt is shared with the server in
`packages/shared/src/threadSplitPrompt.json`. Each request contains one question:
pplx's joint question attention makes scores depend on siblings when batched.
Truncated requests and inference failures abstain and are counted separately.

## Run

Use Python 3.13 on Apple Silicon with `mlx-decision==1.1.0` and a local model.
This evaluation uses Python because the measured runtime is MLX; it does not
call a paid provider or download model weights.

```sh
python3 -m unittest discover -s evals/thread-split
python3 evals/thread-split/run.py --cases /path/to/private-cases.json \
  --model /path/to/pplx-decider-flash-v1.2 --threshold 0.94 \
  --out /path/to/new-run
```

The output directory must not exist. It receives scores, abstentions, request
latencies, the exact prompt, input digest, threshold and confusion counts.
The threshold is explicit; this runner never tunes it on evaluation labels.

Cases are a JSON array with `id`, `session`, `label` (`INDEPENDENT` or `DEPENDS`),
and `state` containing only `prior_thread` and `new_message`. Prior thread entries
contain `user` and `assistant_final`. The new message's answer must never enter
state. Keep private transcripts outside the repository. Use only synthetic,
anonymized cases in committed fixtures.

Choose thresholds using separate calibration sessions; evaluate on wholly new
sessions. Label before scoring, keep ambiguous labels visible, and report real
messages separately from synthetic task switches. Repeat model samples before
drawing conclusions. Abstentions are neither correct predictions nor negatives.

## Evidence and draft boundary

The exploratory November 3 pilot had 190 messages from 44 sessions, with only
nine independent messages. Pplx/direct caught three of nine with one false flag
among 181 dependent messages at the sample-selected cutoff 0.938570. Median
latency was 0.898 seconds; p95 was 5.614 seconds. Those counts were calibrated
and measured on the same sample, so they do not establish held-out accuracy.
A separate synthetic-switch analysis used a different cutoff (about 0.919);
do not combine those thresholds or treat either as a production default.

The app integration is opt-in, passive and asynchronous, using an explicitly
configured local endpoint. It requires user action to move a draft into a fresh
thread. Validate on new sessions before considering a default-on rollout.
Automatic splitting and interrupting prompts are outside this feature.
