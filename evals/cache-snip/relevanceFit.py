#!/usr/bin/env python3
"""Runs `mlx-decision training fit`, working around a crash on one-row batches.

usage: python relevanceFit.py <mlx-decision training fit arguments>
mlx-decision 1.1.0 sends no attention mask for a one-row batch, and on MLX 0.32.4 that
attention has no gradient path. A shuffle that leaves one row over crashes the last step of
a pass and loses the whole run, so the leftover row joins the batch before it.
"""
import runpy
import sys

import mlx_decision.training.finetune as finetune

_batches = finetune.batches


def batches(items, rng=None):
    result = _batches(items, rng)
    if rng is not None and len(result) > 1 and len(result[-1]) == 1:
        leftover = result.pop()
        result[-1] = result[-1] + leftover
    return result


finetune.batches = batches
sys.argv = ["mlx-decision", "training", "fit", *sys.argv[1:]]
runpy.run_module("mlx_decision", run_name="__main__", alter_sys=True)
