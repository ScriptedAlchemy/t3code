#!/usr/bin/env python3
"""Compares scored models with plain recency on the same rows, by split.

usage: python3 evals/cache-snip/relevanceReport.py <artifact dir> [split]
A higher score must mean "still needed", so the stale question is inverted.
"""
import glob
import json
import os
import statistics
import sys

import numpy as np
from sklearn.metrics import roc_auc_score

artifact = sys.argv[1]
split = sys.argv[2] if len(sys.argv) > 2 else "calibration"
rows = {}
for line in open(os.path.join(artifact, "relevance-compact.jsonl")):
    row = json.loads(line)
    if row["split"] == split:
        rows[row["id"]] = row
numeric = {}
path = os.path.join(artifact, "relevance-scores.csv")
if os.path.exists(path):
    for line in open(path):
        key, value = line.rstrip("\n").split(",")
        numeric[key] = float(value)


def session_of(identifier):
    return identifier.split(":")[0]


def auc(ids, scores):
    labels = [rows[i]["used"] for i in ids]
    return roc_auc_score(labels, scores) if len(set(labels)) == 2 else float("nan")


def interval(ids, scores):
    by_session = {}
    for identifier, score in zip(ids, scores):
        by_session.setdefault(session_of(identifier), []).append((identifier, score))
    sessions = list(by_session)
    random = np.random.default_rng(7)
    draws = []
    for _ in range(1000):
        picked = random.integers(0, len(sessions), len(sessions))
        pairs = [pair for index in picked for pair in by_session[sessions[index]]]
        labels = [rows[i]["used"] for i, _ in pairs]
        if len(set(labels)) == 2:
            draws.append(roc_auc_score(labels, [score for _, score in pairs]))
    return np.percentile(draws, [2.5, 97.5])


def line(name, ids, scores, seconds=None):
    if len(ids) < 20:
        return
    low, high = interval(ids, scores)
    timing = f"  median {statistics.median(seconds):5.2f}s" if seconds else ""
    print(f"  {name:32s} AUC {auc(ids, scores):.3f} [{low:.3f},{high:.3f}]  n {len(ids)}{timing}")


def report(title, keep):
    ids = [i for i, row in rows.items() if keep(row)]
    print(f"\n{title} ({len(ids)} rows, {sum(rows[i]['used'] for i in ids)} used later)")
    line("recency of last use", ids, [-rows[i]["idle"] for i in ids])
    known = [i for i in ids if i in numeric]
    line("numeric features", known, [numeric[i] for i in known])
    for file in sorted(glob.glob(os.path.join(artifact, "relevance-scores-*.jsonl"))):
        name = os.path.basename(file)[len("relevance-scores-") : -len(".jsonl")]
        by_prompt = {}
        for raw in open(file):
            result = json.loads(raw)
            if result["id"] in ids and result.get("score") is not None:
                by_prompt.setdefault(result["prompt"], []).append(result)
        for prompt, results in by_prompt.items():
            sign = -1 if prompt == "stale" else 1
            line(
                f"{name} {prompt}",
                [result["id"] for result in results],
                [sign * result["score"] for result in results],
                [result["seconds"] for result in results],
            )


print(f"split: {split}")
report("All sampled head blocks", lambda row: True)
report("Idle over 30 calls", lambda row: row["idle"] > 30)
report("Codex", lambda row: row["provider"] == "codex")
report("Claude", lambda row: row["provider"] == "claude")
