"""Pooled latency and score-drift checks across repeated local runs. Aggregate output only."""
import argparse
import json
from pathlib import Path

import evaluate as e


def load(paths):
    return [json.loads(Path(p).read_text()) for p in paths]


def label(run):
    if run['policy'] != 'decision':
        return run['policy']
    return f"{Path(run['model']).name}/{run['batch_mode']}"


def latency(runs):
    groups = {}
    for run in runs:
        groups.setdefault(label(run), []).append(run)
    out = []
    for name, group in groups.items():
        case_ms = [c['latency_ms'] for run in group for c in run['cases']]
        per_case = {}
        for run in group:
            for c in run['cases']:
                per_case.setdefault(c['id'], []).append(c['latency_ms'])
        out.append({
            'configuration': name,
            'runs': len(group),
            'cases_per_run': [len(run['cases']) for run in group],
            'pooled_case_ms': e.latency_stats(case_ms),
            'per_case_median_ms': sorted({
                cid: round(sorted(v)[len(v) // 2], 1) for cid, v in per_case.items()
            }.items()),
            'savings_per_run': [run['totals']['saved_fraction'] for run in group],
            'failed_requests': [run['totals']['failed_requests'] for run in group],
            'deadline_cases': [run['totals']['deadline_abstained_cases'] for run in group],
        })
    return out


def timing(paths):
    groups = {}
    for path in paths:
        run = json.loads(Path(path).read_text())
        pass_kind = 'cold' if Path(path).stem.endswith('cold') else 'warm'
        groups.setdefault((label(run), pass_kind), []).append(run)
    rows = []
    for (name, pass_kind), runs in sorted(groups.items()):
        scored = [c['latency_ms'] for run in runs for c in run['cases'] if c['scored_blocks']]
        protected = [c['latency_ms'] for run in runs for c in run['cases'] if not c['scored_blocks']]
        per_case = {}
        for run in runs:
            for c in run['cases']:
                per_case.setdefault(c['id'], []).append(c['latency_ms'])
        rows.append({'configuration': name, 'pass': pass_kind, 'runs': len(runs),
                     'scored_case_ms': e.latency_stats(scored),
                     'protected_only_case_ms': e.latency_stats(protected),
                     'per_case_median_ms': [
                         {'case': cid, 'tokens': next(c['before'] for run in runs for c in run['cases']
                                                      if c['id'] == cid),
                          'scored_blocks': next(c['scored_blocks'] for run in runs for c in run['cases']
                                                if c['id'] == cid),
                          'median_ms': round(sorted(v)[len(v) // 2], 1), 'n': len(v)}
                         for cid, v in sorted(per_case.items())]})
    return rows


def drift(a, b, threshold):
    left = {c['id']: {d['block']: d for d in c['decisions']} for c in a['cases']}
    right = {c['id']: {d['block']: d for d in c['decisions']} for c in b['cases']}
    shared = sorted(set(left) & set(right))
    diffs = []
    flips = []
    for cid in shared:
        for block in sorted(set(left[cid]) & set(right[cid])):
            x, y = left[cid][block], right[cid][block]
            if x['p_keep'] is None or y['p_keep'] is None:
                continue
            d = abs(x['p_keep'] - y['p_keep'])
            diffs.append(d)
            keep_x = x['protected'] or x['p_keep'] >= threshold
            keep_y = y['protected'] or y['p_keep'] >= threshold
            if keep_x != keep_y:
                flips.append({'case': cid, 'block': block, 'a': round(x['p_keep'], 4),
                              'b': round(y['p_keep'], 4)})
    return {'a': label(a), 'b': label(b), 'shared_cases': len(shared), 'blocks': len(diffs),
            'max_abs_drift': round(max(diffs), 4) if diffs else None,
            'mean_abs_drift': round(sum(diffs) / len(diffs), 5) if diffs else None,
            'flips_at_threshold': len(flips), 'threshold': threshold, 'flip_examples': flips[:10]}


def do_latency(a):
    payload = latency(load(a.results))
    if a.out:
        Path(a.out).write_text(json.dumps(payload, indent=1))
    print(json.dumps(payload, indent=1))


def do_timing(a):
    payload = timing(a.results)
    if a.out:
        Path(a.out).write_text(json.dumps(payload, indent=1))
    print(json.dumps(payload, indent=1))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    q = sub.add_parser('latency')
    q.add_argument('results', nargs='+')
    q.add_argument('--out')
    q.set_defaults(fn=do_latency)
    q = sub.add_parser('timing')
    q.add_argument('results', nargs='+')
    q.add_argument('--out')
    q.set_defaults(fn=do_timing)
    q = sub.add_parser('drift')
    q.add_argument('--a', required=True)
    q.add_argument('--b', required=True)
    q.add_argument('--threshold', type=float, default=0.1)
    q.set_defaults(fn=lambda a: print(json.dumps(
        drift(json.loads(Path(a.a).read_text()), json.loads(Path(a.b).read_text()), a.threshold),
        indent=1)))
    a = p.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
