"""Choose a per-candidate threshold at an equal deletion budget. No model runs.

The budget is a share of the original tokens, matched on development cases only. It is a
comparison device, not a quality claim: equal compression lets the blind review compare what each
configuration drops rather than how much.
"""
import argparse
import json
import math
from pathlib import Path

import evaluate as e


def validate_cohort(results, cases):
    expected = None
    for result in results:
        ids = [r['id'] for r in result['cases']]
        if not ids or len(ids) != len(set(ids)):
            raise ValueError('Threshold comparison requires nonempty, unique checkpoints')
        cohort = set(ids)
        if not cohort <= cases.keys():
            raise ValueError('Threshold cohort contains checkpoints absent from the manifest')
        if expected is not None and cohort != expected:
            raise ValueError('Threshold comparison requires the same checkpoint cohort')
        expected = cohort


def measure(result, cases, threshold):
    before = after = dropped = 0
    for r in result['cases']:
        case = cases[r['id']]
        original = e.source_payload(case)['output']
        outcome = e.derive_case(r, threshold, original, case=case)
        before += e.tokens(e.text(original))
        after += e.tokens(e.text(outcome['selected']))
        dropped += sum(v == 'drop' for v in outcome['effective'].values())
    return {'threshold': threshold, 'before': before, 'after': after,
            'saved_fraction': round((before - after) / before, 4) if before else None,
            'dropped_blocks': dropped}


def choose(result, cases, target, grid):
    validate_cohort([result], cases)
    if isinstance(target, bool) or not isinstance(target, (int, float)) \
            or not math.isfinite(target) or not 0 <= target <= 1:
        raise ValueError('Target savings must be a finite fraction from 0 to 1')
    if not grid:
        raise ValueError('Threshold grid must not be empty')
    if any(r.get('split') != 'development' or cases[r['id']].get('split') != 'development'
           for r in result['cases']):
        raise ValueError('Threshold selection requires development cases only')
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
    manifest = json.loads(Path(a.cases).read_text())['cases']
    cases = {c['id']: c for c in manifest}
    if len(cases) != len(manifest):
        raise ValueError('Case manifest contains duplicate checkpoints')
    results = [json.loads(Path(path).read_text()) for path in a.results]
    validate_cohort(results, cases)
    grid = [round(0.10 + 0.05 * i, 2) for i in range(18)]
    payload = {'target_saved_fraction': a.target, 'grid': grid, 'candidates': {}}
    for path, result in zip(a.results, results):
        best, rows = choose(result, cases, a.target, grid)
        version = e.measurement_contract_label(result)
        name = f"{Path(result['model']).name}/{result['batch_mode']} [{version}]"
        if name in payload['candidates']:
            raise ValueError('Result files share a candidate name: ' + name)
        payload['candidates'][name] = {'result': path,
                                       'request_version': result.get('request_version'),
                                       'measurement_contract': e.measurement_contract(result),
                                       'chosen': {k: best[k] for k in
                                                  ('threshold', 'saved_fraction', 'dropped_blocks')},
                                       'curve': rows}
        print(json.dumps({'candidate': name, 'chosen': payload['candidates'][name]['chosen']}))
    Path(a.out).write_text(json.dumps(payload, indent=2))


if __name__ == '__main__':
    main()
