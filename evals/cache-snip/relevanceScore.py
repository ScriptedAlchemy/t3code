#!/usr/bin/env python3
"""Scores the relevance sample on one local decision model. Resumable, one request at a time.

usage: python relevanceScore.py <artifact dir> <model name> <model path> [split]
Run under the mlx-decision virtualenv, and run one GPU job at a time.
CACHE_SNIP_SAMPLE picks the sample file (relevance-compact.jsonl for small models).
CACHE_SNIP_PROMPTS limits the questions.
"""
import json
import os
import pathlib
import sys
import time

import mlx_decision

artifact = pathlib.Path(sys.argv[1])
name, path = sys.argv[2], sys.argv[3]
split = sys.argv[4] if len(sys.argv) > 4 else "calibration"
PROMPTS = json.loads((pathlib.Path(__file__).parent / "relevanceQuestions.json").read_text())
wanted = os.environ.get("CACHE_SNIP_PROMPTS")
if wanted:
    PROMPTS = {key: PROMPTS[key] for key in wanted.split(",")}
SAMPLE = os.environ.get("CACHE_SNIP_SAMPLE", "relevance-sample.jsonl")
rows = [json.loads(line) for line in (artifact / SAMPLE).read_text().splitlines()]
rows = [row for row in rows if row["split"] == split]
out = artifact / f"relevance-scores-{name}.jsonl"
done = set()
if out.exists():
    for line in out.read_text().splitlines():
        row = json.loads(line)
        done.add((row["id"], row["prompt"]))
max_tokens = os.environ.get("CACHE_SNIP_MAX_TOKENS")
model = mlx_decision.load(path, **({"max_input_tokens": int(max_tokens)} if max_tokens else {}))
print(name, "loaded", model.info().get("max_input_tokens"), flush=True)
with out.open("a") as handle:
    for prompt, question in PROMPTS.items():
        for row in rows:
            if (row["id"], prompt) in done:
                continue
            started = time.perf_counter()
            result = {"id": row["id"], "prompt": prompt, "model": name, "split": split}
            try:
                response = model.decide_request({"state": row["state"], "questions": {prompt: question}})
                # A small encoder reads the start of a long state, and serving would do the same.
                result["score"] = float(response.answers[prompt].noul)
                result["truncated"] = bool(response.truncated)
            except Exception as error:
                if "METAL" in repr(error):
                    raise
                result["score"] = None
                result["error"] = repr(error)[:200]
            result["seconds"] = time.perf_counter() - started
            handle.write(json.dumps(result) + "\n")
            handle.flush()
        print(name, prompt, "done", flush=True)
print(name, "all-done", flush=True)
