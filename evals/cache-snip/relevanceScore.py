#!/usr/bin/env python3
"""Scores the relevance sample on one local decision model. Resumable, one request at a time.

usage: python relevanceScore.py <artifact dir> <model name> <model path> [split]
Run under the mlx-decision virtualenv, and run one GPU job at a time.
"""
import json
import pathlib
import sys
import time

import mlx_decision

artifact = pathlib.Path(sys.argv[1])
name, path = sys.argv[2], sys.argv[3]
split = sys.argv[4] if len(sys.argv) > 4 else "calibration"
PROMPTS = {
    "needed": {
        "type": "noul",
        "instructions": "An agent is about to handle new_user_message. Would it still need the contents of earlier_tool_output, either to handle that message or to finish work still in progress? Answer yes only if it would need the actual contents, not just the fact that the tool ran.",
        "criteria": {
            "true": "The agent still needs these contents.",
            "false": "These contents are no longer relevant: finished work, superseded results, or unrelated to the new message.",
        },
    },
    "stale": {
        "type": "noul",
        "instructions": "Has earlier_tool_output gone stale for this conversation? Answer yes if it could be removed from the agent's context with no effect on how it handles new_user_message and the work still in progress. If removal could hurt, answer no.",
        "criteria": {
            "true": "Safe to remove: it no longer matters.",
            "false": "Keep it: it may still matter.",
        },
    },
}
rows = [json.loads(line) for line in (artifact / "relevance-sample.jsonl").read_text().splitlines()]
rows = [row for row in rows if row["split"] == split]
out = artifact / f"relevance-scores-{name}.jsonl"
done = set()
if out.exists():
    for line in out.read_text().splitlines():
        row = json.loads(line)
        done.add((row["id"], row["prompt"]))
model = mlx_decision.load(path)
print(name, "loaded", model.info().get("max_input_tokens"), flush=True)
with out.open("a") as handle:
    for prompt, question in PROMPTS.items():
        for row in rows:
            if (row["id"], prompt) in done:
                continue
            started = time.perf_counter()
            result = {"id": row["id"], "prompt": prompt, "model": name, "split": split}
            try:
                response = model.decide_request({"state": row["state"], "questions": {"q": question}})
                result["score"] = None if response.truncated else float(response.answers["q"].noul)
                if response.truncated:
                    result["error"] = "truncated"
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
