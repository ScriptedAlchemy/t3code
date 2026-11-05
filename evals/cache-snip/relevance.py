#!/usr/bin/env python3
"""How well can numeric features alone predict that an old tool output is still needed?

usage: python3 evals/cache-snip/relevance.py <artifact dir>
Run relevanceRows.ts first. Writes out-of-fold scores that simulate.ts ranks seeds with.
"""
import os
import sys

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold

artifact = sys.argv[1]
rows = pd.read_csv(os.path.join(artifact, "relevance-rows.csv"))
FEATURES = [
    "tokens", "age", "idle", "usesSoFar", "turnsSinceArrival", "turnsSinceUse", "namedNow",
    "namedBefore", "reread", "superseded", "toolClass", "prompt", "isCold",
]
print(f"rows {len(rows)}, sessions {rows.session.nunique()}, used later {rows.used.mean():.3f}, by tokens {np.average(rows.used, weights=rows.tokens):.3f}")
print("moments per session p50", int(rows.groupby('session').t.nunique().median()), "tool outputs per moment p50 / p90", *[int(v) for v in np.percentile(rows.groupby(['session','t']).size(), [50, 90])])

scores = np.zeros(len(rows))
for train_index, test_index in GroupKFold(n_splits=5).split(rows, groups=rows.session):
    model = HistGradientBoostingClassifier(max_depth=4, max_iter=200, learning_rate=0.07, min_samples_leaf=50, random_state=7)
    train = rows.iloc[train_index]
    model.fit(train[FEATURES], train.used, sample_weight=np.sqrt(train.tokens))
    scores[test_index] = model.predict_proba(rows.iloc[test_index][FEATURES])[:, 1]
rows["score"] = scores


def auc(frame, column, sign=1):
    if frame.used.nunique() < 2:
        return float("nan")
    return roc_auc_score(frame.used, sign * frame[column], sample_weight=frame.tokens)


print("\nToken-weighted AUC for 'still used later', held out by session:")
for name, frame in [("all", rows), ("codex", rows[rows.provider == "codex"]), ("claude", rows[rows.provider == "claude"]), ("older than 50 calls", rows[rows.age > 50]), ("idle over 30 calls", rows[rows.idle > 30])]:
    print(f"  {name:22s} model {auc(frame, 'score'):.3f}  recency of last use {auc(frame, 'idle', -1):.3f}  age {auc(frame, 'age', -1):.3f}  n {len(frame)}")

named = rows[rows.namedNow == 1]
print(f"\nNamed by the new message: {len(named)} rows, used later {np.average(named.used, weights=named.tokens):.3f}. Not named: {np.average(rows[rows.namedNow == 0].used, weights=rows[rows.namedNow == 0].tokens):.3f}")
for low, high in [(0, 5), (5, 20), (20, 50), (50, 100), (100, 10**9)]:
    bucket = rows[(rows.idle >= low) & (rows.idle < high)]
    if len(bucket):
        print(f"  idle {low:>3}-{high if high < 10**9 else 'inf':<4} share of tokens {bucket.tokens.sum() / rows.tokens.sum():.2f}, used later {np.average(bucket.used, weights=bucket.tokens):.3f}")

latest = rows.ts.max()
split = latest - 7 * 86_400_000
past, recent = rows[rows.ts < split], rows[rows.ts >= split]
if len(past) > 1000 and len(recent) > 1000:
    model = HistGradientBoostingClassifier(max_depth=4, max_iter=200, learning_rate=0.07, min_samples_leaf=50, random_state=7)
    model.fit(past[FEATURES], past.used, sample_weight=np.sqrt(past.tokens))
    recent = recent.assign(score=model.predict_proba(recent[FEATURES])[:, 1])
    print(f"\nTrained on the past, tested on the last week: AUC {auc(recent, 'score'):.3f}, recency alone {auc(recent, 'idle', -1):.3f}")

keys = rows.session + ":" + rows.t.astype(str) + ":" + rows.block.astype(str)
pd.DataFrame({"key": keys, "score": rows.score.round(4)}).to_csv(os.path.join(artifact, "relevance-scores.csv"), index=False, header=False)
