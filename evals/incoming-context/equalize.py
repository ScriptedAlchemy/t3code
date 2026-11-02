"""Choose a per-candidate threshold at an equal deletion budget. No model runs.

The budget is a share of the original tokens, matched on development cases only. It is a
comparison device, not a quality claim: equal compression lets the blind review compare what each
configuration drops rather than how much.
"""
import argparse
import json
from pathlib import Path

import evaluate as e


def measure(result, cases, threshold):
    before = after = dropped = 0
    for r in result['cases']:
        original = e.source_payload(cases[r['id']])['output']
        plan, selected, _, guarded = e.rethreshold(r, threshold, original)
        before += e.tokens(e.text(original))
        after += e.tokens(e.text(selected))
        dropped += sum(1 for d in r['decisions']
                       if not d['protected'] and d['p_keep'] is not None and d['p_keep'] < threshold) \
            if not guarded else 0
    return {'threshold': threshold, 'before': before, 'after': after,
            'saved_fraction': round((before - after) / before, 4) if before else None,
            'dropped_blocks': dropped}


def choose(result, cases, target, grid):
    rows = [measure(result, cases, t) for t in grid]
    best = min(rows, key=lambda m: (abs((m['saved_fraction'] or 0) - target), -m['threshold']))
    return best, rows


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--results', nargs='+', required=True)
    p.add_argument('--cases', default='context_eval/runs/cases-dev40.json')
    p.add_argument('--target', type=float, default=0.15)
    p.add_argument('--out', default='context_eval/runs/thresholds.json')
    a = p.parse_args()
    cases = {c['id']: c for c in json.loads(Path(a.cases).read_text())['cases']}
    grid = [round(0.10 + 0.05 * i, 2) for i in range(18)]
    payload = {'target_saved_fraction': a.target, 'grid': grid, 'candidates': {}}
    for path in a.results:
        result = json.loads(Path(path).read_text())
        best, rows = choose(result, cases, a.target, grid)
        name = f"{Path(result['model']).name}/{result['batch_mode']}"
        payload['candidates'][name] = {'result': path,
                                       'chosen': {k: best[k] for k in
                                                  ('threshold', 'saved_fraction', 'dropped_blocks')},
                                       'curve': rows}
        print(json.dumps({'candidate': name, 'chosen': payload['candidates'][name]['chosen']}))
    Path(a.out).write_text(json.dumps(payload, indent=2))


if __name__ == '__main__':
    main()
