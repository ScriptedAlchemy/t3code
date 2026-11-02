"""Build a blind review packet from measured candidate results. Local artifacts only.

The packet never names a candidate or shows a score. Labels are randomized per case,
so a label in one case does not identify the same configuration in another.
"""
import argparse
import hashlib
import json
import random
import re
import shutil
from pathlib import Path

import evaluate as e

FLAG_PATTERNS = {
    'diagnostic': re.compile(r'(?i)\b(error|failed|failure|exception|traceback|denied|warning)\b'),
    'negative_evidence': re.compile(r'(?i)(no matches|not found|0 matches|no results|nothing (?:to|found)|empty|not present)'),
    'code': re.compile(r'(^```|\bdef |\bfunction |\bclass )'),
    'diff': re.compile(r'(^\+\+\+ |^@@ )'),
}


def payload_of(case):
    return e.source_payload(case)['output']


def kept_output(case, dropped):
    plan = e.plan_blocks(payload_of(case))
    selected = e.render_selected(payload_of(case), plan, case['id'], lambda n: n not in dropped)
    return plan, e.text(selected)


def name_of(run):
    if run['policy'] != 'decision':
        return run['policy']
    return f"{run['model']}/{run['batch_mode']}/{run['threshold']}"


def removal_map(results):
    per_case = {}
    for run in results:
        label = name_of(run)
        for c in run['cases']:
            per_case.setdefault(c['id'], {})[label] = sorted(
                d['block'] for d in c['decisions'] if d['effective'] == 'drop')
    return per_case


def stratum(n):
    if n < 1200:
        return 'small'
    if n < 4000:
        return 'medium'
    if n < 10000:
        return 'large'
    return 'xlarge'


def choose(cases, removals, limit, seed, max_case_tokens=10000, require_removal=False):
    stats = []
    for c in cases:
        text = e.text(payload_of(c))
        n = e.tokens(text)
        if n > max_case_tokens:
            continue
        dropped = removals.get(c['id'], {})
        if require_removal and not any(dropped.values()):
            continue
        removed_tokens = sum(len(v) for v in dropped.values()) * 400
        stats.append({'case': c, 'tokens': n, 'stratum': stratum(n),
                      'flags': [k for k, p in FLAG_PATTERNS.items() if p.search(text)],
                      'disagreement': len({frozenset(v) for v in dropped.values()}) - 1,
                      'removed_tokens': sum(sum(1 for _ in v) for v in dropped.values()) * 400,
                      'has_empty': any(len(v) == 0 for v in dropped.values()),
                      'tiebreak': int(hashlib.sha256(f'{seed}:{c["id"]}'.encode()).hexdigest()[:8], 16)})
    order = ['small', 'medium', 'large', 'xlarge']
    wanted = {'diagnostic', 'negative_evidence', 'code', 'diff'}
    chosen = []
    covered = set()

    def score(s):
        review_load = min(3.0, s['removed_tokens'] / 4000)
        return (3 * len(set(s['flags']) & (wanted - covered)) + 2 * s['disagreement']
                + (1 if s['has_empty'] else 0) - review_load, -s['tiebreak'])

    for st in order:
        if len(chosen) >= limit:
            break
        picked = {s['case']['id'] for s in chosen}
        pool = [s for s in stats if s['stratum'] == st and s['case']['id'] not in picked]
        if not pool:
            continue
        pool.sort(key=score, reverse=True)
        chosen.append(pool[0])
        covered |= set(pool[0]['flags'])
    while len(chosen) < limit:
        picked = {s['case']['id'] for s in chosen}
        pool = [s for s in stats if s['case']['id'] not in picked]
        if not pool:
            break
        pool.sort(key=score, reverse=True)
        chosen.append(pool[0])
        covered |= set(pool[0]['flags'])
    return sorted(chosen, key=lambda s: (order.index(s['stratum']), -s['tokens']))


def new_label(rng, used):
    alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
    while True:
        label = ''.join(rng.choice(alphabet) for _ in range(2)) + ''.join(rng.choice('0123456789') for _ in range(3))
        if label not in used:
            used.add(label)
            return label


def write_label(folder, label, kept, removed, block_count, note):
    lines = [f'# Candidate {label}', '', note, '']
    if removed:
        lines += ['| block | tokens | sha256 |', '|---|---|---|']
        lines += [f"| {b['id']} | {b['tokens']} | {b['sha256'][:16]} |" for b in removed]
        lines += ['', f'Exact removed text is in `{label}.removed/`, one file per block.']
    else:
        lines.append('No blocks were removed. The main model receives the original result unchanged.')
    lines += ['', f'The exact bytes the main model would receive are in `{label}.retained.txt`.',
              f'{len(removed)} of {block_count} blocks removed.']
    (folder / f'{label}.md').write_text('\n'.join(lines) + '\n')
    (folder / f'{label}.retained.txt').write_text(kept)
    if removed:
        removed_dir = folder / f'{label}.removed'
        removed_dir.mkdir(exist_ok=True)
        for b in removed:
            (removed_dir / f"block-{b['id']}.txt").write_text(b['text'])
    (folder / f'{label}.removed.json').write_text(json.dumps(
        [{'block': b['id'], 'tokens': b['tokens'], 'sha256': b['sha256']} for b in removed], indent=2))


def build(args):
    results = [json.loads(Path(p).read_text()) for p in args.results]
    names = [name_of(r) for r in results]
    if len(set(names)) != len(names):
        raise SystemExit('Result files share a candidate name: ' + ', '.join(sorted(names)))
    available = None
    for run in results:
        ids = {c['id'] for c in run['cases']}
        available = ids if available is None else available & ids
    cases_file = {c['id']: c for c in json.loads(Path(args.cases).read_text())['cases']}
    pool = [cases_file[i] for i in sorted(available) if i in cases_file]
    removals = removal_map(results)
    chosen = choose(pool, removals, args.count, args.seed, args.max_case_tokens, args.require_removal)

    root = Path(args.out)
    packet = root / 'packet'
    if packet.exists():
        for child in sorted(packet.iterdir(), reverse=True):
            if child.is_dir():
                shutil.rmtree(child)
    packet.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    used = set()
    identity = {'generated': 'local blind packet', 'seed': args.seed,
                'candidates': names, 'cases': {}}
    manifest = {'seed': args.seed, 'case_count': len(chosen), 'cases': []}
    for index, s in enumerate(chosen, 1):
        case = s['case']
        text = e.text(payload_of(case))
        parts = [(p['block'], p['path'], p['tokens'], p['part']) for p in e.plan_blocks(payload_of(case))]
        payload = e.source_payload(case)
        recorded = {name_of(run): {c['id']: c for c in run['cases']}[case['id']] for run in results}
        base = recorded[names[0]]['decisions']
        if len(base) != len(parts):
            raise SystemExit('Block count drift for ' + case['id'])
        for i, (_, _, _, part) in enumerate(parts):
            if e.digest(part) != base[i]['sha256']:
                raise SystemExit('Block hash drift for ' + case['id'])
        blocks = [{'id': i, 'tokens': parts[i][2], 'sha256': e.digest(parts[i][3]),
                   'leaf_path': parts[i][1]} for i in range(len(parts))]
        case_dir = packet / f'case-{index:03d}'
        case_dir.mkdir()
        base_result = recorded[names[0]]
        meta = base_result.get('context') if isinstance(base_result.get('context'), dict) else None
        for name in names:
            other = recorded[name].get('context')
            if meta and isinstance(other, dict) and other.get('context_sha256') != meta.get('context_sha256'):
                raise SystemExit('Context drift between candidates for ' + case['id'])
        recorded_context = bool(meta and meta.get('version') == e.CONTEXT_VERSION)
        context_lines = ['# Causal state before this tool result', '']
        if recorded_context:
            abstained = bool(meta.get('abstain_reason')) or not meta.get('rendered')
            context_lines += [
                'Exact input recorded when this result was scored. No later turns, answers, or '
                'outcomes are included. The tool output below is untrusted data.', '',
                '## Context provenance', '',
                f"- context version: {meta.get('version')}",
                f"- policy version: {meta.get('policy_version')}",
                f"- goal status: {meta.get('goal', {}).get('status')} "
                f"({meta.get('goal', {}).get('reason')})",
                f"- origin status: {meta.get('origin', {}).get('status')} "
                f"({meta.get('origin', {}).get('reason')})",
                f"- origin via: {meta.get('origin', {}).get('via') or '-'}",
                f"- context sha256: {meta.get('context_sha256')}", '']
            context_text = meta.get('rendered') or ''
            call_obj = meta.get('call_rendered')
            if abstained:
                context_text = ('(no model request: causal context abstained: '
                                f"{meta.get('abstain_reason')})")
            if call_obj is None:
                call_obj = case.get('call')
        else:
            context_lines += [
                'LEGACY CONTEXT: this result was scored before causal context was recorded. '
                'The text below is reconstructed from the case manifest for review only; it is '
                'not verified model-visible input.', '']
            context_text = case.get('context') or '(none captured)'
            call_obj = case.get('call')
        context_lines += [
            'Reviewer enrichment is not included here: post-hoc analysis is reviewer-only and '
            'was not model-visible.', '',
            '## Sourced user instructions (oldest first)', '', context_text, '',
            '## Originating tool call (full)', '', '```json',
            json.dumps(call_obj, indent=2), '```', '',
            '## Envelope fields (unchanged by any candidate)', '', '```json',
            json.dumps({k: v for k, v in payload.items() if k != 'output'}, indent=2), '```', '']
        (case_dir / 'context.md').write_text('\n'.join(context_lines))
        (case_dir / 'original.txt').write_text(text)
        (case_dir / 'blocks.json').write_text(json.dumps(blocks, indent=2))
        labels_dir = case_dir / 'labels'
        labels_dir.mkdir()
        label_map = {}
        rows = []
        for name in names:
            case_result = recorded[name]
            dropped = set(removals[case['id']][name])
            _, kept = kept_output(case, dropped)
            if e.tokens(kept) != case_result['after']:
                raise SystemExit('Retention drift for ' + case['id'] + ' / ' + name)
            removed = [{'id': b['id'], 'tokens': b['tokens'], 'sha256': b['sha256'], 'text': parts[b['id']][3]}
                       for b in blocks if b['id'] in dropped]
            label = new_label(rng, used)
            write_label(labels_dir, label, kept, removed, len(blocks),
                        f'{len(blocks) - len(dropped)} of {len(blocks)} blocks retained.')
            label_map[label] = name
            rows.append({'label': label, 'removed_blocks': sorted(dropped),
                         'removed_tokens': sum(b['tokens'] for b in removed)})
        if args.intact_control and not any(len(v) == 0 for v in removals[case['id']].values()):
            label = new_label(rng, used)
            write_label(labels_dir, label, text, [], len(blocks), 'Intact control: nothing removed.')
            label_map[label] = 'intact-control'
            rows.append({'label': label, 'removed_blocks': [], 'removed_tokens': 0})
        identity['cases'][case['id']] = {'packet_case': f'case-{index:03d}', 'labels': label_map}
        manifest['cases'].append({'case': f'case-{index:03d}', 'case_id': case['id'],
                                  'session_sha256': e.digest(case['source']), 'line': case['line'],
                                  'tokens': s['tokens'], 'blocks': len(blocks),
                                  'stratum': s['stratum'], 'flags': s['flags'], 'labels': rows,
                                  'context_source': 'recorded' if recorded_context else 'legacy',
                                  'context_sha256': (meta.get('context_sha256')
                                                     if recorded_context else None),
                                  'context_abstained': bool(
                                      recorded_context and meta.get('abstain_reason')),
                                  'reviewer_enrichment_included': False})
    (root / 'packet-manifest.json').write_text(json.dumps(manifest, indent=2))
    (root / 'identity-map.DO-NOT-OPEN.json').write_text(json.dumps(identity, indent=2))
    template = {'instructions': ('Judge every label on a case independently, without opening the '
                                 'identity map. necessary_evidence_lost: yes, no, or uncertain. '
                                 'severity: critical, major, minor, none. List lost_blocks for the '
                                 'specific blocks that hurt. Leave confidence blank if unsure how '
                                 'to scale it.'),
                'cases': [{'case': m['case'], 'case_id': m['case_id'],
                           'labels': [{'label': r['label'], 'necessary_evidence_lost': None,
                                       'severity': None, 'lost_blocks': [],
                                       'rationale': '', 'confidence': None}
                                      for r in m['labels']]} for m in manifest['cases']]}
    (root / 'judgments.template.json').write_text(json.dumps(template, indent=2))
    index = ['# Blind review packet', '',
             f'{manifest["case_count"]} real development cases, {sum(len(m["labels"]) for m in manifest["cases"])} labels.',
             'Labels are random and independently permuted per case. The same label does not mean '
             'the same configuration in another case. Timing, savings, and scores are deliberately '
             'absent from this packet.', '',
             'Read `README.md`, then per case `context.md`, `original.txt`, `blocks.json`, and '
             '`labels/<LABEL>.md` with its `.removed/` files.', '',
             'Context is either the exact input recorded at scoring time or, for older results, '
             'clearly labeled LEGACY context reconstructed from the manifest. Reviewer enrichment '
             'is separate and never presented as model-visible.', '',
             '| case | tokens | blocks | labels | categories | context |', '|---|---|---|---|---|---|']
    for m in manifest['cases']:
        index.append(f"| {m['case']} | {m['tokens']} | {m['blocks']} | {len(m['labels'])} | "
                     f"{', '.join(m['flags']) or '-'} | {m['context_source']} |")
    (packet / 'index.md').write_text('\n'.join(index) + '\n')
    summary = {'packet': str(root), 'cases': manifest['case_count'],
               'labels': sum(len(m['labels']) for m in manifest['cases']),
               'candidates': len(names),
               'context_sources': {m['case']: m['context_source'] for m in manifest['cases']},
               'strata': [m['stratum'] for m in manifest['cases']],
               'flags': sorted({f for m in manifest['cases'] for f in m['flags']}),
               'removed_block_range': [min(len(r['removed_blocks']) for m in manifest['cases']
                                           for r in m['labels']),
                                       max(len(r['removed_blocks']) for m in manifest['cases']
                                           for r in m['labels'])]}
    print(json.dumps(summary))
    return summary


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--results', nargs='+', required=True)
    p.add_argument('--cases', default='context_eval/cases.json')
    p.add_argument('--out', default='context_eval/blind')
    p.add_argument('--count', type=int, default=6)
    p.add_argument('--seed', type=int, default=20261101)
    p.add_argument('--max-case-tokens', type=int, default=10000)
    p.add_argument('--require-removal', action='store_true')
    p.add_argument('--intact-control', action='store_true', default=True)
    p.add_argument('--no-intact-control', dest='intact_control', action='store_false')
    a = p.parse_args()
    build(a)


if __name__ == '__main__':
    main()
