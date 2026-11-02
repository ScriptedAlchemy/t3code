"""Selection accounting: one derivation of proposals vs effective output.

These tests drive the real guard paths (deadline retention and recomputed non-expansion) and
compare the derived rerender/sweep numbers byte-for-byte against live selection.
"""
import contextlib
import io
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import evaluate as e


def args(**over):
    base = dict(policy='decision', threshold=0.1, batch='shared-state', batch_questions=64,
                batch_tokens=20000, deadline_ms=0, max_tokens=7500, backend='mlx', timeout=60.0,
                model='test', key_env=None, endpoint='http://localhost')
    base.update(over)
    return SimpleNamespace(**base)


def write_case(folder, body):
    path = Path(folder) / 'rollout.jsonl'
    lines = [
        {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user',
                                              'content': [{'type': 'input_text',
                                                           'text': 'Goal: fix the parser'}]}},
        {'type': 'response_item', 'payload': {'type': 'function_call', 'call_id': 'abc',
                                              'name': 'read', 'arguments': '{"path":"parser.py"}'}},
        {'type': 'response_item', 'payload': {'type': 'function_call_output', 'call_id': 'abc',
                                              'status': 'completed', 'output': body}},
    ]
    path.write_text('\n'.join(json.dumps(line) for line in lines) + '\n')
    return {'id': 'case-0001', 'source': str(path), 'line': 3, 'split': 'development',
            'sha256': e.digest(e.text(body)), 'context': 'Goal: fix the parser',
            'call': {'name': 'read', 'arguments': '{"path":"parser.py"}'},
            'original_tokens': e.tokens(e.text(body))}


def scores(mapping):
    """Shared-state scorer keyed by block number, so geometry and scores stay explicit."""
    def fake(a, payload):
        return ({q: mapping[int(q[1:])] for q in payload['questions']}, 1.0, {})
    return fake


def slow_score(a, payload):
    """Spends real time so the case deadline, not the scorer, ends the measurement."""
    time.sleep(0.05)
    return {q: 0.0 for q in payload['questions']}, 50.0, {}


def expanding_body():
    """Real geometry where dropping one middle block would make the output longer.

    Block 0 is 399 tokens and protected (first). Block 1 is a lone 6-token line, so replacing
    it with the 14-token omission marker expands the result. Blocks 2-4 are large, block 5 is
    the protected tail.
    """
    head = ''.join(f'    line_{i} = compute("value_{i}", target_{i}, checksum_{i})\n'
                   for i in range(21))
    tiny = '    x = 1\n'
    huge = '    blob = "' + 'word ' * 900 + '"\n'
    tail = ''.join(f'    tail_{i} = verify("row_{i}", CONSTRAINT_{i})\n' for i in range(60))
    return head + tiny + huge + tail


def plain_body(lines=200):
    return ''.join(f'    row_{i} = select("key_{i}", filter_{i}, limit_{i})\n'
                   for i in range(lines))


BODY = expanding_body()
SCORES = {1: 0.05, 2: 0.30, 3: 0.50, 4: 0.90}


def live(folder, body, mapping, **over):
    case = write_case(folder, body)
    with patch.object(e, 'score_request', scores(mapping)):
        return case, e.score_case(args(**over), case)


def report(live_case, threshold=0.1):
    return e.build_report(args(threshold=threshold), [live_case], {})


def call(fn, ns):
    with contextlib.redirect_stdout(io.StringIO()):
        fn(ns)


def rerender_into(folder, result, case, threshold):
    result_path = Path(folder) / 'result.json'
    cases_path = Path(folder) / 'cases.json'
    out = Path(folder) / f'rerender-{threshold}.json'
    result_path.write_text(json.dumps(result))
    cases_path.write_text(json.dumps({'cases': [case]}))
    call(e.rerender, SimpleNamespace(result=str(result_path), cases=str(cases_path),
                                     threshold=threshold, out=str(out)))
    return json.loads(out.read_text())


def sweep_into(folder, result, case, thresholds):
    result_path = Path(folder) / 'result.json'
    cases_path = Path(folder) / 'cases.json'
    out = Path(folder) / 'sweep.json'
    result_path.write_text(json.dumps(result))
    cases_path.write_text(json.dumps({'cases': [case]}))
    call(e.sweep, SimpleNamespace(result=str(result_path), cases=str(cases_path),
                                  thresholds=thresholds, out=str(out)))
    return json.loads(out.read_text())


class ProposalTests(unittest.TestCase):
    def test_proposal_rule_from_frozen_score(self):
        self.assertEqual(e.proposal(0.09, False, 0.1), 'drop')
        self.assertEqual(e.proposal(0.1, False, 0.1), 'keep')
        self.assertEqual(e.proposal(0.0, True, 0.1), 'keep')
        self.assertEqual(e.proposal(None, False, 0.1), 'keep')

    def test_geometry_fixture_is_what_the_guards_exercise(self):
        plan = e.plan_blocks(BODY)
        self.assertEqual([p['block'] for p in plan], [0, 1, 2, 3, 4, 5])
        self.assertEqual([p['tokens'] for p in plan], [399, 6, 905, 400, 400, 160])
        self.assertEqual([p['protected'] for p in plan], [True, False, False, False, False, True])
        self.assertEqual(e.tokens(BODY), 2270)
        self.assertEqual(e.tokens(e.MARKER.format(block=1, id='case-0001')), 14)
        self.assertGreater(e.tokens(e.MARKER.format(block=1, id='case-0001')), plan[1]['tokens'])


class NonExpansionTests(unittest.TestCase):
    def test_non_expansion_fires_and_is_not_a_saving(self):
        with tempfile.TemporaryDirectory() as tmp:
            case, result = live(tmp, BODY, SCORES)
        self.assertEqual(result['guard'], 'non-expansion')
        self.assertEqual((result['before'], result['after']), (2270, 2270))
        tiny = result['decisions'][1]
        self.assertEqual((tiny['p_keep'], tiny['proposed'], tiny['effective'], tiny.get('guard')),
                         (0.05, 'drop', 'keep', 'non-expansion'))
        self.assertEqual(result['decisions'][2]['proposed'], 'keep')
        self.assertNotIn('guard', result['decisions'][2])

    def test_rerender_matches_live_selection_and_keeps_the_proposal(self):
        with tempfile.TemporaryDirectory() as tmp:
            case, result = live(tmp, BODY, SCORES)
            frozen = json.loads(json.dumps(result))
            again = rerender_into(tmp, report(result), case, 0.1)
        self.assertEqual(again['cases'][0]['after'], 2270)
        self.assertEqual(again['cases'][0]['after_sha256'], result['after_sha256'])
        self.assertEqual(again['cases'][0]['guard'], 'non-expansion')
        self.assertEqual(again['cases'][0]['decisions'][1]['proposed'], 'drop')
        self.assertEqual(again['cases'][0]['decisions'][1]['effective'], 'keep')
        self.assertEqual(again['cases'][0]['decisions'][1]['guard'], 'non-expansion')
        self.assertEqual(again['totals']['dropped_blocks'], 0)
        self.assertEqual(again['totals']['proposed_drops'], 1)
        self.assertEqual(again['totals']['guarded_cases'], 1)
        self.assertEqual(again['totals']['saved_fraction'], 0.0)
        # The measured observation is evidence and stays untouched.
        self.assertEqual(result, frozen)

    def test_rerender_recomputes_non_expansion_instead_of_inheriting_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            case, result = live(tmp, BODY, SCORES)
            cheaper = rerender_into(tmp, report(result), case, 0.02)
            saving = rerender_into(tmp, report(result), case, 0.7)
        # 0.02 keeps every block: no drops, so the old guard no longer applies.
        self.assertIsNone(cheaper['cases'][0]['guard'])
        self.assertEqual((cheaper['cases'][0]['after'], cheaper['totals']['dropped_blocks']),
                         (2270, 0))
        self.assertEqual(cheaper['totals']['guarded_cases'], 0)
        # 0.7 drops the big middle blocks, so the output really is smaller: no guard.
        self.assertIsNone(saving['cases'][0]['guard'])
        self.assertEqual(saving['cases'][0]['after'], 1001)
        self.assertEqual(saving['totals']['dropped_blocks'], 3)
        self.assertEqual(saving['totals']['guarded_cases'], 0)

    def test_rerender_at_a_new_threshold_reproposes_from_frozen_scores(self):
        with tempfile.TemporaryDirectory() as tmp:
            case, result = live(tmp, BODY, SCORES)
            before = {d['block']: d['proposed'] for d in result['decisions']}
            higher = rerender_into(tmp, report(result), case, 0.7)
        after = {d['block']: d['proposed'] for d in higher['cases'][0]['decisions']}
        self.assertEqual(before, {0: 'keep', 1: 'drop', 2: 'keep', 3: 'keep', 4: 'keep', 5: 'keep'})
        self.assertEqual(after, {0: 'keep', 1: 'drop', 2: 'drop', 3: 'drop', 4: 'keep', 5: 'keep'})
        self.assertEqual({d['block'] for d in higher['cases'][0]['decisions']
                          if d['effective'] == 'drop'}, {1, 2, 3})
        # The frozen scores are the input to every new threshold; only the proposal moves.
        self.assertEqual([d['p_keep'] for d in higher['cases'][0]['decisions']],
                         [d['p_keep'] for d in result['decisions']])

    def test_sweep_counts_effective_drops_and_bytes_like_live_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            case, result = live(tmp, BODY, SCORES)
            with patch.object(e, 'score_request', scores(SCORES)):
                selected = e.score_case(args(threshold=0.7), case)
            rows = {r['threshold']: r for r in sweep_into(tmp, report(result), case,
                                                         '0.1,0.7')['thresholds']}
        # guarded row: one proposal, zero savings
        self.assertEqual(rows[0.1]['before'], 2270)
        self.assertEqual(rows[0.1]['after'], 2270)
        self.assertEqual(rows[0.1]['dropped_blocks'], 0)
        self.assertEqual(rows[0.1]['saved_fraction'], 0.0)
        self.assertEqual(rows[0.1]['removed_share_of_unprotected_tokens'], 0.0)
        # unguarded row: derived numbers equal the live measurement at the same threshold
        self.assertIsNone(selected['guard'])
        self.assertEqual(rows[0.7]['after'], selected['after'])
        self.assertEqual(rows[0.7]['after'], 1001)
        self.assertEqual(rows[0.7]['dropped_blocks'],
                         sum(1 for d in selected['decisions'] if d['effective'] == 'drop'))
        self.assertEqual(rows[0.7]['dropped_blocks'], 3)
        self.assertEqual(rows[0.7]['saved_fraction'], 0.559)
        self.assertEqual(rows[0.7]['removed_share_of_unprotected_tokens'], 0.7417)


class DeadlineRetentionTests(unittest.TestCase):
    def measured_deadline_case(self, folder):
        case = write_case(folder, plain_body())
        with patch.object(e, 'score_request', slow_score):
            result = e.score_case(args(batch_questions=2, deadline_ms=60), case)
        return case, result

    def test_deadline_retention_is_not_a_saving_and_keeps_proposals(self):
        with tempfile.TemporaryDirectory() as tmp:
            case, result = self.measured_deadline_case(tmp)
            self.assertTrue(result['deadline_abstain'])
            self.assertEqual(result['guard'], 'deadline')
            self.assertEqual(result['after'], result['before'])
            scored = [d for d in result['decisions']
                      if not d['protected'] and d['p_keep'] is not None]
            self.assertGreaterEqual(len(scored), 2)
            rerendered = rerender_into(tmp, report(result), case, 0.5)
            swept = sweep_into(tmp, report(result), case, '0.1,0.5')
        self.assertEqual(rerendered['cases'][0]['guard'], 'deadline')
        self.assertEqual(rerendered['cases'][0]['after'], result['before'])
        self.assertEqual(rerendered['cases'][0]['after_sha256'], result['after_sha256'])
        for d in rerendered['cases'][0]['decisions']:
            if d['block'] in {x['block'] for x in scored}:
                self.assertEqual((d['p_keep'], d['proposed'], d['effective'], d['guard']),
                                 (0.0, 'drop', 'keep', 'deadline'))
            else:
                self.assertEqual(d['proposed'], 'keep')
        self.assertEqual(rerendered['totals']['dropped_blocks'], 0)
        self.assertEqual(rerendered['totals']['proposed_drops'], len(scored))
        self.assertEqual(rerendered['totals']['guarded_cases'], 0)
        for row in swept['thresholds']:
            # Deadline retention can never be reported as a saving at any threshold.
            self.assertEqual(row['dropped_blocks'], 0)
            self.assertEqual(row['after'], result['before'])
            self.assertEqual(row['saved_fraction'], 0.0)


class FailureRetentionTests(unittest.TestCase):
    def test_scoring_failure_and_abstention_never_become_savings(self):
        def broken(a, payload):
            raise e.Failure('timeout', 'read timed out', 12.5)

        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, plain_body())
            with patch.object(e, 'score_request', broken):
                result = e.score_case(args(), case)
            self.assertEqual(result['guard'], None)
            self.assertEqual(result['after'], result['before'])
            swept = sweep_into(tmp, report(result), case, '0,0.5')
        for row in swept['thresholds']:
            self.assertEqual(row['dropped_blocks'], 0)
            self.assertEqual(row['after'], result['before'])
            self.assertEqual(row['saved_fraction'], 0.0)

    def test_rethreshold_returns_plan_and_guard_contract(self):
        def broken(a, payload):
            raise e.Failure('oversize', 'state too long', 1.0)

        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, plain_body())
            with patch.object(e, 'score_request', broken):
                dead = e.score_case(args(deadline_ms=0), case)
            plan, selected, by_block, guarded = e.rethreshold(dead, 0.5, e.text(e.source(case)))
        self.assertEqual(selected, e.text(e.source(case)))
        self.assertEqual(by_block[0]['p_keep'], 1.0)
        self.assertFalse(guarded)  # nothing was proposed, so no guard had to retain it
        self.assertEqual(len(plan), len(dead['decisions']))


class LiveParityTests(unittest.TestCase):
    def test_plain_save_is_identical_when_measured_and_derived(self):
        mapping = {i: 0.0 for i in range(1, 9)}
        with tempfile.TemporaryDirectory() as tmp:
            case, result = live(tmp, plain_body(), mapping, threshold=0.5)
            rows = {r['threshold']: r for r in sweep_into(tmp, report(result), case,
                                                          '0.5')['thresholds']}
            rerendered = rerender_into(tmp, report(result), case, 0.5)
        self.assertIsNone(result['guard'])
        self.assertLess(result['after'], result['before'])
        row = rows[0.5]
        self.assertEqual((row['before'], row['after'], row['dropped_blocks']),
                         (result['before'], result['after'],
                          sum(1 for d in result['decisions'] if d['effective'] == 'drop')))
        self.assertEqual(rerendered['cases'][0]['after'], result['after'])
        self.assertEqual({d['block'] for d in rerendered['cases'][0]['decisions']
                          if d['effective'] == 'drop'},
                         {d['block'] for d in result['decisions'] if d['effective'] == 'drop'})


class BlockIdentityTests(unittest.TestCase):
    def test_swapped_ids_cannot_move_scores_to_other_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, result = live(tmp, BODY, SCORES)
        rows = result['decisions']
        rows[1]['block'], rows[2]['block'] = rows[2]['block'], rows[1]['block']
        with self.assertRaisesRegex(ValueError, 'Block identity drift'):
            e.derive_case(result, 0.5, BODY)


if __name__ == '__main__':
    unittest.main()
