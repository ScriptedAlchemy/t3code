#!/usr/bin/env python3
"""Can a model choose when to compact better than a fixed rule? Held-out sessions, real dollars.

usage: python3 evals/cache-snip/learn.py <artifact dir>
Numeric features only, so it runs on CPU and needs no chat text. Run decisions.ts first.
"""
import json
import os
import sys

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import GroupKFold

artifact = sys.argv[1]
frame = pd.read_csv(os.path.join(artifact, "decisions.csv"))
results = json.load(open(os.path.join(artifact, "simulate-results-refetch1.json")))
BASE = {provider: results[provider]["never"][0] for provider in results}
FEATURES = [
    "prompt", "offset", "sessionCalls", "userTurns", "callsPerTurn", "gapMinutes", "isCold",
    "isUserTurn", "prevReadShare", "missOverRead", "readUsdPerCall", "longTier", "growthPerCall",
    "toolShare", "idle10Share", "idle30Share", "priorTurnShare", "callsThisTurn", "userEstimate",
]
THRESHOLDS = [100, 125, 150, 175, 200, 225, 250, 260, 270, 300]
REFETCH_RATES = ["1", "0.3", "0.1"]
MOMENTS = {
    "any moment": lambda rows: np.ones(len(rows), bool),
    "user turn": lambda rows: rows.isUserTurn.to_numpy() == 1,
    "cold": lambda rows: rows.isCold.to_numpy() == 1,
}


def per_session(rows, chosen, column):
    """Compact at the first chosen moment of each epoch. Dollars saved per session."""
    picked = rows[chosen].sort_values("t").groupby(["session", "epoch"], sort=False).head(1)
    return picked.groupby("session")[column].sum()


def oracle(rows, column):
    best = rows.groupby(["session", "epoch"])[column].max().clip(lower=0)
    return best.groupby("session").sum()


def learned_rule(train, test, column, moment):
    allowed = MOMENTS[moment]
    def saved(rows, threshold):
        return per_session(rows, allowed(rows) & (rows.prompt.to_numpy() >= threshold * 1000), column).sum()
    best = max(THRESHOLDS, key=lambda threshold: saved(train, threshold))
    return per_session(test, allowed(test) & (test.prompt.to_numpy() >= best * 1000), column), best


def stopping_model(train, test, column):
    """Labels a moment positive only when it is near the best moment left in the epoch, since waiting is an option."""
    ordered = train.sort_values(["session", "epoch", "t"])
    remaining_best = ordered.groupby(["session", "epoch"])[column].transform(lambda values: values[::-1].cummax()[::-1])
    labels = ((ordered[column] > 0) & (ordered[column] >= 0.9 * remaining_best)).astype(int)
    model = HistGradientBoostingClassifier(
        max_depth=3, max_iter=200, learning_rate=0.05, min_samples_leaf=15, random_state=7
    )
    model.fit(ordered[FEATURES], labels, sample_weight=ordered[column].abs().clip(lower=1e-3))
    return per_session(test, model.predict_proba(test[FEATURES])[:, 1] > 0.5, column)


def interval(values, sessions, base):
    aligned = values.reindex(sessions).fillna(0).to_numpy()
    draws = aligned[np.random.default_rng(7).integers(0, len(aligned), (4000, len(aligned)))].sum(axis=1)
    low, high = np.percentile(draws, [2.5, 97.5])
    return aligned.sum() / base * 100, low / base * 100, high / base * 100


def compare(rows, title):
    print(f"\n== {title}: % of provider spend saved [95% CI], one compaction per epoch")
    for provider in ["codex", "claude"]:
        subset = rows[rows.provider == provider].reset_index(drop=True)
        sessions = subset.session.unique()
        for rate in REFETCH_RATES:
            column = f"net{rate}"
            collected = {f"rule, {moment}": pd.Series(dtype=float) for moment in MOMENTS}
            collected["model"] = pd.Series(dtype=float)
            chosen_thresholds = {moment: [] for moment in MOMENTS}
            for train_index, test_index in GroupKFold(n_splits=5).split(subset, groups=subset.session):
                train, test = subset.iloc[train_index], subset.iloc[test_index]
                for moment in MOMENTS:
                    saved, threshold = learned_rule(train, test, column, moment)
                    chosen_thresholds[moment].append(threshold)
                    collected[f"rule, {moment}"] = pd.concat([collected[f"rule, {moment}"], saved])
                collected["model"] = pd.concat([collected["model"], stopping_model(train, test, column)])
            base = BASE[provider]
            print(f"\n{provider}, baseline ${base:.0f}, refetch {rate}")
            print("  {:28s} {:6.1f} [{:6.1f},{:6.1f}]".format("oracle", *interval(oracle(subset, column), sessions, base)))
            for name, values in collected.items():
                note = ""
                if name.startswith("rule"):
                    note = f" thresholds {sorted(set(chosen_thresholds[name.split(', ')[1]]))}"
                print("  {:28s} {:6.1f} [{:6.1f},{:6.1f}]{}".format(name, *interval(values, sessions, base), note))
            for moment in MOMENTS:
                difference = collected["model"].reindex(sessions).fillna(0) - collected[f"rule, {moment}"].reindex(sessions).fillna(0)
                print("  {:28s} {:6.1f} [{:6.1f},{:6.1f}]".format(f"model minus rule, {moment}", *interval(difference, sessions, base)))


compare(frame, "held out by session")

latest = frame.ts.max()
split = latest - 7 * 86_400_000
past, recent = frame[frame.ts < split], frame[frame.ts >= split]
print(f"\n== trained on the past, tested on the last week: {len(past)} training moments, {len(recent)} test moments")
for provider in ["codex", "claude"]:
    train, test = past[past.provider == provider], recent[recent.provider == provider]
    sessions = test.session.unique()
    if len(train) < 50 or len(test) < 20:
        print(f"{provider}: too few moments, train {len(train)}, test {len(test)}. Pooling providers instead.")
        train = past
    for rate in REFETCH_RATES:
        column = f"net{rate}"
        rule_saved, threshold = learned_rule(train, test, column, "any moment")
        model_saved = stopping_model(train, test, column)
        base = BASE[provider]
        print(
            f"{provider} refetch {rate}: oracle {interval(oracle(test, column), sessions, base)[0]:5.1f}, "
            f"rule(>{threshold}k) {interval(rule_saved, sessions, base)[0]:5.1f}, model {interval(model_saved, sessions, base)[0]:5.1f}, "
            f"model minus rule {interval(model_saved.reindex(sessions).fillna(0) - rule_saved.reindex(sessions).fillna(0), sessions, base)}"
        )
