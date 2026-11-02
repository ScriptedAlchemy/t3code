"""Pooled latency and score-drift checks across repeated local runs. Aggregate output only."""
import argparse
import json
from pathlib import Path
from statistics import median

import evaluate as e


def load(paths):
    return [json.loads(Path(p).read_text()) for p in paths]


def label(run):
    if run['policy'] != 'decision':
        return run['policy']
    version = e.measurement_contract_label(run)
    return f"{Path(run['model']).name}/{run['batch_mode']} [{version}]"


def configuration(run):
    receipt = run.get('receipts') or {}
    return {'model': run.get('model'), 'backend': run.get('backend'),
            'batch_mode': run.get('batch_mode'),
            **{key: receipt.get(key) for key in (
                'deadline_ms', 'batch_questions', 'batch_tokens', 'max_request_tokens',
                'timeout_s', 'warmup', 'machine', 'runtime', 'tokenizer', 'chunker')}}


def group_key(run):
    settings = json.dumps(configuration(run), sort_keys=True)
    return label(run), settings


def group_label(name, settings):
    return name + ' config=' + e.digest(settings)[:12]


def latency(runs):
    groups = {}
    for run in runs:
        groups.setdefault(group_key(run), []).append(run)
    out = []
    for (name, settings), group in groups.items():
        case_ms = [c['latency_ms'] for run in group for c in run['cases']]
        per_case = {}
        for run in group:
            for c in run['cases']:
                per_case.setdefault(c['id'], []).append(c['latency_ms'])
        out.append({
            'configuration': group_label(name, settings),
            'inference_configuration': json.loads(settings),
            'runs': len(group),
            'cases_per_run': [len(run['cases']) for run in group],
            'pooled_case_ms': e.latency_stats(case_ms),
            'per_case_median_ms': sorted({
                cid: round(median(v), 1) for cid, v in per_case.items()
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
        groups.setdefault((*group_key(run), pass_kind), []).append(run)
    rows = []
    for (name, settings, pass_kind), runs in sorted(groups.items()):
        scored = [c['latency_ms'] for run in runs for c in run['cases'] if c['scored_blocks']]
        protected, abstained, unscored = [], [], []
        for run in runs:
            for c in run['cases']:
                if c['scored_blocks']:
                    continue
                if (c.get('context_abstained') or c.get('output_abstained')
                        or c.get('deadline_abstain') or any(
                            d.get('reason', '').startswith('abstain') for d in c['decisions'])):
                    bucket = abstained
                elif all(d['protected'] or d.get('hard_keep') for d in c['decisions']):
                    bucket = protected
                else:
                    bucket = unscored
                bucket.append(c['latency_ms'])
        per_case = {}
        for run in runs:
            for c in run['cases']:
                per_case.setdefault(c['id'], []).append(c['latency_ms'])
        rows.append({'configuration': group_label(name, settings),
                     'inference_configuration': json.loads(settings),
                     'pass': pass_kind, 'runs': len(runs),
                     'scored_case_ms': e.latency_stats(scored),
                     'protected_only_case_ms': e.latency_stats(protected),
                     'abstained_case_ms': e.latency_stats(abstained),
                     'unscored_case_ms': e.latency_stats(unscored),
                     'per_case_median_ms': [
                         {'case': cid, 'tokens': next(c['before'] for run in runs for c in run['cases']
                                                      if c['id'] == cid),
                          'scored_blocks': next(c['scored_blocks'] for run in runs for c in run['cases']
                                                if c['id'] == cid),
                          'median_ms': round(median(v), 1), 'n': len(v)}
                         for cid, v in sorted(per_case.items())]})
    return rows


def drift(a, b, threshold):
    if e.measurement_contract(a) != e.measurement_contract(b):
        raise ValueError('Score drift requires the same request contract')
    e.proposal(None, False, threshold)
    left_cases = {c['id']: c for c in a['cases']}
    right_cases = {c['id']: c for c in b['cases']}
    if (not left_cases or set(left_cases) != set(right_cases)
            or len(left_cases) != len(a['cases']) or len(right_cases) != len(b['cases'])):
        raise ValueError('Score drift requires the same unique checkpoint cohort')
    shared = sorted(left_cases)
    diffs = []
    flips = []
    for cid in shared:
        left_case, right_case = left_cases[cid], right_cases[cid]
        context_fields = ('context_sha256', 'rendered', 'call_rendered')
        left_context = left_case.get('context') or {}
        right_context = right_case.get('context') or {}
        if (not left_context.get('context_sha256')
                or any(left_context.get(k) != right_context.get(k) for k in context_fields)):
            raise ValueError('Score drift requires identical causal context for ' + cid)
        if any(left_case.get(k) != right_case.get(k)
               for k in ('source', 'line', 'before_sha256')):
            raise ValueError('Source identity drift for ' + cid)
        left = {d['block']: d for d in left_case['decisions']}
        right = {d['block']: d for d in right_case['decisions']}
        if (set(left) != set(right) or len(left) != len(left_case['decisions'])
                or len(right) != len(right_case['decisions'])):
            raise ValueError('Block identity drift for ' + cid)
        for block in sorted(left):
            x, y = left[block], right[block]
            if x.get('sha256') != y.get('sha256') or x.get('path') != y.get('path'):
                raise ValueError('Block identity drift for ' + cid)
            if x['p_keep'] is None or y['p_keep'] is None:
                continue
            keep_x = e.proposal(x['p_keep'], x['protected'], threshold) == 'keep'
            keep_y = e.proposal(y['p_keep'], y['protected'], threshold) == 'keep'
            d = abs(x['p_keep'] - y['p_keep'])
            diffs.append(d)
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
