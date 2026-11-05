# Cache snip

Would removing stale history from a thread lower total input cost, once the cache rebuild is charged? This replays real sessions against T3's own pricing code. It calls no model, costs nothing, and writes numbers and hashes only, never chat text.

Run against copies, and keep the output out of the repo:

```sh
mkdir -p <dir>
cp ~/.t3/userdata/usage-model-rates.json ~/.t3/userdata/usage-scan-cache-v11.json <dir>
cd evals
pnpm cache-snip:spend <dir>            # dollars by category, model, provider
pnpm cache-snip:shape <dir> 30         # prompt sizes, cold calls, long-context cost
pnpm cache-snip:replay <dir> 30        # transcripts to per-session call and block records
pnpm cache-snip:compose <dir> 30       # what prompts are made of
for rate in 1 0.3 0.1; do
  CACHE_SNIP_REFETCH=$rate pnpm cache-snip:simulate <dir> 30
  cp <dir>/simulate-results.json <dir>/simulate-results-refetch$rate.json
done
pnpm cache-snip:decisions <dir> 30     # dollar net of compacting at each candidate moment
python3 cache-snip/learn.py <dir>      # model against fixed rules, held out by session and by time
pnpm cache-snip:relevance-rows <dir> 30 # what was knowable about each old tool output at each cut
python3 cache-snip/relevance.py <dir>  # still-needed model, then rerun simulate to rank seeds with it
pnpm cache-snip:relevance-sample <dir> # old tool outputs with the message they faced. Holds chat text, keep it local
<mlx-decision venv>/bin/python cache-snip/relevanceScore.py <dir> <name> <model path> # one GPU job at a time
```

`learn.py` needs numpy, pandas, and scikit-learn.

## Reading the numbers

- A snip at call `t` costs a rebuild of everything after the first removed block, and saves that block's reads on every later call before the next compaction. `simulate.ts` charges both. Its no-snip replay must reproduce T3's priced cost, and it prints that check first.
- `CACHE_SNIP_REFETCH` is the share of wrong snips that make an agent fetch the content again. It decides most outcomes, so report every result across a range.
- `CACHE_SNIP_REEXPLORE=tokens,calls` charges what a fresh chat re-reads per head cut. Set it from real handoff sessions.
- "Later quoted" is how `replay.ts` decides a block was used. It misses silent use, so the relevance ceiling depends on it.
- Replays measure dollars, never answer quality. Lost context that degrades an agent's work without a re-fetch does not show up here.
