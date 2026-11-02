"""Integration tests for causal-context wiring and requested-evidence retention.

All fixtures are synthetic and public. Nothing here executes transcript content,
reads the identity map, or calls a model: scoring is replaced by explicit fakes.
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

import blind_packet as bp
import evaluate as e


def args(**over):
    base = dict(policy='decision', threshold=0.1, batch='shared-state',
                batch_questions=64, batch_tokens=20000, deadline_ms=0,
                max_tokens=7500, backend='mlx', timeout=60.0, model='test',
                key_env=None, endpoint='http://localhost')
    base.update(over)
    return SimpleNamespace(**base)


def write_session(folder, users, call, output, after=(), name='rollout.jsonl',
                  legacy_context='STALE MANIFEST CONTEXT'):
    path = Path(folder) / name
    lines = []
    for message in users:
        lines.append({'type': 'response_item',
                      'payload': {'type': 'message', 'role': 'user',
                                  'content': [{'type': 'input_text', 'text': message}]}})
    lines.append({'type': 'response_item', 'payload': call})
    lines.append({'type': 'response_item',
                  'payload': {'type': 'function_call_output',
                              'call_id': call['call_id'], 'status': 'completed',
                              'output': output}})
    for message in after:
        lines.append({'type': 'response_item',
                      'payload': {'type': 'message', 'role': 'user',
                                  'content': [{'type': 'input_text', 'text': message}]}})
    path.write_text('\n'.join(json.dumps(line) for line in lines) + '\n')
    body = e.text(output)
    return {'id': 'case-0001', 'source': str(path), 'line': len(users) + 2,
            'split': 'development', 'sha256': e.digest(body),
            'context': legacy_context, 'call': call,
            'original_tokens': e.tokens(body)}


def call(arguments, name='exec', call_id='call-1', field='arguments'):
    payload = {'type': 'function_call', 'call_id': call_id, 'name': name}
    payload[field] = json.dumps(arguments) if field == 'arguments' else arguments
    return payload


def zero(a, payload):
    return ({q: 0.0 for q in payload['questions']}, 1.0, {})


def evidence_body():
    """Blocks 1-4 carry requested evidence; block 1 is unrelated and droppable."""
    body = ''.join(f'    head_{i} = load("alpha_{i}", beta_{i}, gamma_{i})\n'
                   for i in range(30))
    body += ''.join(f'    noise_{i} = unrelated("theta_{i}", omega_{i}, sigma_{i})\n'
                    for i in range(30))
    for i in range(8):
        body += f'    drwxr-xr-x  14 zack  staff  448 Oct 29 10:00 t3code_{i}\n'
        body += f'    drwxr-xr-x  14 zack  staff  448 Oct 29 10:00 tracedecay_{i}\n'
    body += ''.join(f'    ctor_{i} = Case(defaults_{i}, fixture_{i}, local_{i})\n'
                    for i in range(10))
    body += ''.join(f'    revoke_{i} = revoke_project_server(request_{i}, reason_{i})\n'
                    for i in range(10))
    body += ''.join(f'    tail_{i} = verify("row_{i}", CONSTRAINT_{i})\n'
                    for i in range(30))
    return body


def evidence_session(folder, **over):
    output = over.pop('output', evidence_body())
    users = over.pop('users', ['Compare the t3code and tracedecay repositories.',
                               'Keep the Case constructor visible.'])
    request = over.pop('call', call({'path': '/Volumes/shared/dirs',
                                     'pattern': 'Case|project_server.*revok'}))
    after = over.pop('after', ())
    return write_session(folder, users, request, output, after=after)


def words(n, prefix='word', size=18):
    return ''.join(f'    {prefix}_{i} = "' + ('value ' * size) + f'{i}"\n'
                   for i in range(n))


def grouped_body():
    """Plain head, one diagnostic line, plain tail: forces protected siblings and groups."""
    head = ''.join(f'    head_{i} = load("alpha_{i}", beta_{i}, gamma_{i})\n' for i in range(100))
    diag = 'error: permission denied while reading /Volumes/x/config.json\n'
    tail = ''.join(f'    tail_{i} = verify("row_{i}", CONSTRAINT_{i})\n' for i in range(200))
    return head + diag + tail


def state_of(payload):
    return payload['state']['candidate_tool_output']['blocks']


def questioned(payload):
    return sorted(int(q[1:]) for q in payload['questions'])


class MissingContextTests(unittest.TestCase):
    def test_harness_envelope_only_abstains_without_calling_scorer(self):
        body = words(60, 'out')
        request = call({'path': 'parser.py'})
        with tempfile.TemporaryDirectory() as tmp:
            envelope = '# AGENTS.md instructions for /Volumes/x\n\n<INSTRUCTIONS>\npolicy\n'
            case = write_session(tmp, [envelope], request, body)
            with patch.object(e, 'score_request') as scorer:
                result = e.score_case(args(), case)
                scorer.assert_not_called()
        self.assertFalse(result['context_ok'])
        self.assertTrue(result['context_abstained'])
        self.assertIn('goal_missing', result['context_abstain_reason'])
        self.assertEqual(result['after'], result['before'])
        self.assertEqual(result['batches'], [])
        self.assertEqual(result['statuses'], {})
        self.assertTrue(all(d['effective'] == 'keep' for d in result['decisions']))
        self.assertTrue(any(d['reason'] == 'abstain: missing_context'
                            for d in result['decisions']))
        self.assertTrue(result['receipt']['model_visible']['abstained'])
        self.assertIsNone(result['receipt']['model_visible']['context'])
        self.assertFalse(result['manifest_context_used'])

    def test_unresolved_poll_origin_abstains_without_calling_scorer(self):
        body = words(60, 'poll-output')
        request = call({'cell_id': '999'}, name='wait')
        with tempfile.TemporaryDirectory() as tmp:
            case = write_session(tmp, ['Investigate the failing build.'], request, body)
            with patch.object(e, 'score_request') as scorer:
                result = e.score_case(args(), case)
                scorer.assert_not_called()
        self.assertFalse(result['context_ok'])
        self.assertTrue(result['context_abstained'])
        self.assertEqual(result['context']['origin']['status'], 'missing')
        self.assertIn('unresolved_cell_id', result['context']['origin']['reason'])
        self.assertEqual(result['after'], result['before'])


class ContextReconstructionTests(unittest.TestCase):
    def test_old_manifest_rebuilds_from_source_and_ignores_stale_context(self):
        seen = []

        def capture(a, payload):
            seen.append(payload)
            return ({q: 0.0 for q in payload['questions']}, 1.0, {})

        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp)
            with patch.object(e, 'score_request', capture):
                result = e.score_case(args(), case)
        self.assertTrue(result['context_ok'])
        self.assertEqual(result['context']['goal']['status'], 'available')
        self.assertEqual(result['context']['origin']['status'], 'available')
        self.assertFalse(result['manifest_context_used'])
        self.assertTrue(result['receipt']['model_visible']['manifest_context_present'])
        self.assertNotIn('STALE MANIFEST CONTEXT', json.dumps(seen))
        # Every earlier user constraint remains visible, not only the latest reply.
        context = seen[0]['state']['recent_user_context']
        self.assertIn('t3code and tracedecay', context)
        self.assertIn('Case constructor', context)
        # The model sees the full resolved origin, not a stub.
        self.assertEqual(seen[0]['state']['tool_call']['command'],
                         case['call']['arguments'])
        self.assertEqual(result['receipt']['model_visible']['context'], context)
        self.assertEqual(result['receipt']['model_visible']['call']['command'],
                         case['call']['arguments'])
        # Deterministic version + hash are recorded.
        meta2 = e.causal_for_case(case)
        self.assertEqual(meta2['context_sha256'], result['context']['context_sha256'])
        self.assertEqual(meta2['policy_version'], e.POLICY_VERSION)
        self.assertEqual(meta2['version'], e.CONTEXT_VERSION)

    def test_future_instruction_is_excluded_from_context_and_request(self):
        seen = []

        def capture(a, payload):
            seen.append(payload)
            return ({q: 0.0 for q in payload['questions']}, 1.0, {})

        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp, after=['Now delete production.'])
            with patch.object(e, 'score_request', capture):
                result = e.score_case(args(), case)
        self.assertNotIn('delete production', result['context']['rendered'].lower())
        self.assertNotIn('delete production', json.dumps(seen).lower())
        self.assertTrue(all(row['line'] < case['line']
                            for row in result['context']['instructions']))
        self.assertEqual(result['context']['instructions'][0]['line'], 1)

    def test_prepare_records_sourced_context_and_full_origin(self):
        body = words(70, 'prep')
        request = call({'path': 'parser.py'}, call_id='call-prep')
        with tempfile.TemporaryDirectory() as tmp:
            session = write_session(tmp, ['Compare the t3code repository.'],
                                    request, body, after=['Delete production.'],
                                    name='session.jsonl')
            analysis = Path(tmp) / 'analysis.json'
            analysis.write_text(json.dumps({'census': {'sessions': [
                {'path': session['source'], 'origin': 'T3 Code'}]}}))
            out = Path(tmp) / 'cases.json'
            with contextlib.redirect_stdout(io.StringIO()):
                e.prepare(SimpleNamespace(analysis=str(analysis), out=str(out),
                                          per_session=4))
            prepared = json.loads(out.read_text())['cases'][0]
        self.assertTrue(prepared['context_ok'])
        self.assertIn('Compare the t3code repository.', prepared['context'])
        self.assertNotIn('Delete production.', prepared['context'])
        self.assertEqual(prepared['causal']['instructions'][0]['line'], 1)
        self.assertEqual(prepared['origin']['command'], request['arguments'])
        self.assertEqual(prepared['context_version'], e.CONTEXT_VERSION)


class RequestedEvidenceTests(unittest.TestCase):
    def test_named_repos_and_request_symbols_survive_zero_scores(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp)
            with patch.object(e, 'score_request', zero):
                result = e.score_case(args(threshold=0.1), case)
        retained = {d['block']: d for d in result['decisions']}
        hits = {n: [t['value'] for t in d['evidence_terms']]
                for n, d in retained.items() if d['evidence_terms']}
        joined = {v for values in hits.values() for v in values}
        self.assertIn('t3code', joined)
        self.assertIn('tracedecay', joined)
        self.assertIn('Case', joined)
        self.assertIn('project_server', joined)
        self.assertIn('revok', joined)
        for block, terms in hits.items():
            d = retained[block]
            if not d['protected']:
                self.assertEqual(d['proposed'], 'drop')
                self.assertEqual(d['effective'], 'keep')
                self.assertEqual(d.get('retained_by'), 'requested evidence')
                self.assertTrue(d['hard_keep'])
        # An unrelated middle block still follows the model score and drops.
        unrelated = [d for d in result['decisions']
                     if not d['protected'] and not d['evidence_terms']]
        self.assertTrue(unrelated)
        self.assertTrue(all(d['effective'] == 'drop' for d in unrelated))
        self.assertLess(result['after'], result['before'])
        self.assertFalse(result['context_abstained'])

    def test_evidence_retention_is_not_silently_a_model_keep(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp)
            with patch.object(e, 'score_request', zero):
                result = e.score_case(args(threshold=0.1), case)
        for d in result['decisions']:
            if d.get('retained_by') == 'requested evidence':
                self.assertEqual(d['proposed'], 'drop')
                self.assertEqual(d['effective'], 'keep')
                self.assertNotEqual(d.get('guard'), 'non-expansion')


class DerivedSelectionTests(unittest.TestCase):
    def rerender_into(self, folder, result, case, threshold):
        result_path = Path(folder) / 'result.json'
        cases_path = Path(folder) / 'cases.json'
        out = Path(folder) / f'rerender-{threshold}.json'
        result_path.write_text(json.dumps(result))
        cases_path.write_text(json.dumps({'cases': [case]}))
        with contextlib.redirect_stdout(io.StringIO()):
            e.rerender(SimpleNamespace(result=str(result_path), cases=str(cases_path),
                                       threshold=threshold, out=str(out)))
        return json.loads(out.read_text())

    def sweep_into(self, folder, result, case, thresholds):
        result_path = Path(folder) / 'result.json'
        cases_path = Path(folder) / 'cases.json'
        out = Path(folder) / 'sweep.json'
        result_path.write_text(json.dumps(result))
        cases_path.write_text(json.dumps({'cases': [case]}))
        with contextlib.redirect_stdout(io.StringIO()):
            e.sweep(SimpleNamespace(result=str(result_path), cases=str(cases_path),
                                    thresholds=thresholds, out=str(out)))
        return json.loads(out.read_text())

    def test_rethreshold_and_sweep_cannot_drop_evidence_protected_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp)
            with patch.object(e, 'score_request', zero):
                result = e.score_case(args(threshold=0.1), case)
            evidence_blocks = {d['block'] for d in result['decisions']
                               if d['evidence_terms']}
            higher = self.rerender_into(tmp, e.build_report(args(), [result], {}),
                                        case, 0.99)
            swept = self.sweep_into(tmp, e.build_report(args(), [result], {}),
                                    case, '0.0,0.5,0.99')
        for row in higher['cases'][0]['decisions']:
            if row['block'] in evidence_blocks and not row['protected']:
                self.assertEqual(row['effective'], 'keep')
                self.assertEqual(row['proposed'], 'drop')
                self.assertEqual(row.get('retained_by'), 'requested evidence')
        for row in swept['thresholds']:
            kept = {d['block']: d['effective']
                    for d in higher['cases'][0]['decisions']}
            for block in evidence_blocks:
                self.assertEqual(kept[block], 'keep')

    def test_no_context_abstention_survives_rethreshold_and_sweep(self):
        body = words(70, 'ctxless')
        request = call({'path': 'parser.py'})
        envelope = '# AGENTS.md instructions for /Volumes/x\n\n<INSTRUCTIONS>\npolicy\n'
        with tempfile.TemporaryDirectory() as tmp:
            case = write_session(tmp, [envelope], request, body)
            with patch.object(e, 'score_request') as scorer:
                result = e.score_case(args(threshold=0.99), case)
                scorer.assert_not_called()
            higher = self.rerender_into(tmp, e.build_report(args(), [result], {}),
                                        case, 0.0)
            swept = self.sweep_into(tmp, e.build_report(args(), [result], {}),
                                    case, '0.0,0.5,0.99')
        self.assertTrue(result['context_abstained'])
        for row in higher['cases'][0]['decisions']:
            self.assertEqual(row['effective'], 'keep')
        for row in swept['thresholds']:
            self.assertEqual(row['after'], result['before'])
            self.assertEqual(row['dropped_blocks'], 0)
            self.assertEqual(row['saved_fraction'], 0.0)

    def test_deadline_retention_keeps_evidence_and_is_not_a_saving(self):
        def slow(a, payload):
            time.sleep(0.03)
            return ({q: 0.0 for q in payload['questions']}, 30.0, {})

        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp)
            with patch.object(e, 'score_request', slow):
                result = e.score_case(args(threshold=0.1, batch_questions=2,
                                           deadline_ms=25), case)
            self.assertTrue(result['deadline_abstain'])
            self.assertEqual(result['guard'], 'deadline')
            self.assertEqual(result['after'], result['before'])
            rerendered = self.rerender_into(tmp, e.build_report(args(), [result], {}),
                                            case, 0.0)
            swept = self.sweep_into(tmp, e.build_report(args(), [result], {}),
                                    case, '0.0,0.99')
        for row in rerendered['cases'][0]['decisions']:
            self.assertEqual(row['effective'], 'keep')
            if row['evidence_terms']:
                self.assertTrue(row['hard_keep'])
        for row in swept['thresholds']:
            self.assertEqual(row['after'], result['before'])
            self.assertEqual(row['dropped_blocks'], 0)
            self.assertEqual(row['saved_fraction'], 0.0)


class EntireResultStateTests(unittest.TestCase):
    """The scoring state is the whole pending result, and questions never hide siblings."""

    def score(self, body, **over):
        seen = []

        def capture(a, payload):
            seen.append(payload)
            return ({q: 0.5 for q in payload['questions']}, 1.0, {})

        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp, output=body)
            with patch.object(e, 'score_request', capture):
                result = e.score_case(args(**over), case)
        return case, result, seen

    def test_shared_state_shows_protected_siblings_and_other_question_groups(self):
        case, result, seen = self.score(grouped_body(), batch_questions=2)
        plan = e.plan_blocks(e.text(e.source(case)))
        protected = {p['block'] for p in plan if p['protected']}
        targets = {p['block'] for p in plan if not p['protected']}
        self.assertGreater(len(seen), 1)
        self.assertTrue(protected)
        groups = [questioned(payload) for payload in seen]
        # Every request carries the whole result: all blocks, protected ones included.
        for payload in seen:
            self.assertEqual(len(state_of(payload)), len(plan))
            self.assertEqual([b['index'] for b in state_of(payload)],
                             [p['block'] for p in plan])
            self.assertEqual([b['path'] for b in state_of(payload)],
                             [list(p['path']) for p in plan])
        # Questions cover every unprotected block exactly once, and never a protected one.
        self.assertEqual(sorted(b for group in groups for b in group), sorted(targets))
        self.assertEqual(len({b for group in groups for b in group}), len(targets))
        self.assertFalse(protected & {b for group in groups for b in group})
        # A block questioned only in a later request is still visible in the first one.
        last = groups[-1][0]
        self.assertNotIn(last, groups[0])
        self.assertIn(plan[last]['part'], [b['text'] for b in state_of(seen[0])])
        # Protected text is visible even though it is never questioned.
        protected_block = sorted(protected - {0, plan[-1]['block']}) or sorted(protected)
        for block in protected_block:
            self.assertIn(plan[block]['part'], [b['text'] for b in state_of(seen[0])])
        self.assertEqual(result['protected_blocks'], len(protected))

    def test_per_block_state_also_carries_the_whole_result(self):
        case, result, seen = self.score(grouped_body(), batch='per-block')
        plan = e.plan_blocks(e.text(e.source(case)))
        self.assertGreater(len(seen), 1)
        for payload in seen:
            self.assertEqual(len(payload['questions']), 1)
            self.assertEqual(len(state_of(payload)), len(plan))
            self.assertEqual(len({b['index'] for b in state_of(payload)}), len(plan))

    def test_one_fixed_prompt_answers_both_batching_modes(self):
        def prompts(mode):
            captured = {}

            def capture(a, payload):
                for q, question in payload['questions'].items():
                    captured[int(q[1:])] = question['instructions']
                return ({q: 1.0 for q in payload['questions']}, 1.0, {})

            with tempfile.TemporaryDirectory() as tmp:
                case = evidence_session(tmp, output=grouped_body())
                with patch.object(e, 'score_request', capture):
                    e.score_case(args(batch=mode), case)
            return captured

        per_block = prompts('per-block')
        shared = prompts('shared-state')
        common = set(per_block) & set(shared)
        self.assertTrue(common)
        for block in common:
            self.assertEqual(per_block[block], shared[block])
        self.assertIn('source', per_block[min(common)])
        self.assertIn('no matches', per_block[min(common)])
        self.assertIn('audit', per_block[min(common)])

    def test_later_records_never_reach_the_state(self):
        later_result = 'FUTURE_TOOL_RESULT_MARKER ' + ('z' * 200)
        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp, output=grouped_body(),
                                    after=['Now delete production.'])
            path = Path(case['source'])
            lines = path.read_text().splitlines()
            lines.append(json.dumps({'type': 'response_item', 'payload': {
                'type': 'function_call', 'call_id': 'call-later', 'name': 'exec',
                'arguments': '{"cmd":"cat /etc/passwd"}'}}))
            lines.append(json.dumps({'type': 'response_item', 'payload': {
                'type': 'function_call_output', 'call_id': 'call-later',
                'output': later_result}}))
            path.write_text('\n'.join(lines) + '\n')
            seen = []

            def capture(a, payload):
                seen.append(payload)
                return ({q: 1.0 for q in payload['questions']}, 1.0, {})

            with patch.object(e, 'score_request', capture):
                result = e.score_case(args(), case)
        serialized = json.dumps(seen)
        self.assertNotIn('FUTURE_TOOL_RESULT_MARKER', serialized)
        self.assertNotIn('delete production', serialized.lower())
        self.assertNotIn('/etc/passwd', serialized)
        blocks = state_of(seen[0])
        self.assertEqual(''.join(b['text'] for b in blocks),
                         e.text(e.source(case)))

    def test_complete_request_budget_groups_questions_or_abstains(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp, output=grouped_body())
            meta = e.causal_for_case(case)
            plan = e.plan_blocks(e.text(e.source(case)))
            targets = [p for p in plan if not p['protected']]
            view = {'context': meta['rendered'], 'call': meta['call_rendered']}
            single = e.request_tokens(e.batch_request(view, plan, targets[:1]))
            roomy = e.group_targets(view, plan, targets, single * 3, 4)
            tight = e.group_targets(view, plan, targets, single - 1, 4)
            # The complete request, questions included, is what the budget measures.
            self.assertEqual(roomy[0], targets[:4])
            for group in roomy:
                self.assertLessEqual(
                    e.request_tokens(e.batch_request(view, plan, group)), single * 3)
            # One question cannot fit: abstain instead of repeating an oversized state.
            self.assertIsNone(tight)

    def test_budget_abstention_sends_nothing_and_keeps_the_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp, output=grouped_body())
            plan = e.plan_blocks(e.text(e.source(case)))
            targets = [p for p in plan if not p['protected']]
            with patch.object(e, 'score_request') as scorer:
                result = e.score_case(args(batch_tokens=1), case)
                scorer.assert_not_called()
        self.assertEqual(len(result['batches']), 1)
        self.assertEqual(result['requests'], 0)
        self.assertEqual(e.build_report(args(), [result], {})['totals']['requests'], 0)
        self.assertEqual(result['batches'][0]['status'], 'oversize')
        self.assertEqual(result['batches'][0]['questions'], 0)
        self.assertEqual(result['batches'][0]['request_tokens'], 0)
        self.assertEqual(result['batches'][0]['blocks'], [p['block'] for p in targets])
        self.assertEqual(result['after'], result['before'])
        self.assertEqual(set(result['statuses']), {'oversize'})
        self.assertTrue(all(d['effective'] == 'keep'
                            for d in result['decisions'] if not d['protected']))

    def test_oversize_full_state_abstains_without_truncation(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp, output=grouped_body())
            meta = e.causal_for_case(case)
            plan = e.plan_blocks(e.text(e.source(case)))
            targets = [p for p in plan if not p['protected']]
            view = {'context': meta['rendered'], 'call': meta['call_rendered']}
            limit = e.request_tokens(e.batch_request(view, plan, targets)) - 1
            with patch.object(e.urllib.request, 'urlopen') as network:
                result = e.score_case(args(backend='http', max_tokens=limit,
                                           batch_tokens=1_000_000), case)
                network.assert_not_called()
        self.assertEqual(set(result['statuses']), {'oversize'})
        self.assertEqual(result['after'], result['before'])
        self.assertTrue(all(d['effective'] == 'keep' for d in result['decisions']))
        self.assertTrue(all(d['reason'] == 'abstain: oversize'
                            for d in result['decisions'] if not d['protected']))
        self.assertEqual(result['batches'][0]['status'], 'oversize')
        self.assertEqual(result['batches'][0]['blocks_in_state'], len(plan))
        self.assertGreater(result['batches'][0]['request_tokens'], limit)

    def test_prefix_bytes_are_unchanged_by_scoring(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp)
            prefix = e.prefix_bytes(case)
            with patch.object(e, 'score_request', zero):
                result = e.score_case(args(), case)
        self.assertGreater(len(prefix), 0)
        self.assertEqual(result['receipt']['prefix_sha256'], e.digest(prefix))
        self.assertEqual(result['receipt']['prefix_sha256_after'], e.digest(prefix))
        self.assertFalse(result['receipt']['old_prefix_changed'])
        self.assertFalse(result['historical_content_rewritten'])
        self.assertEqual(result['receipt']['prefix_bytes'], len(prefix))

    def test_request_identity_is_recorded_and_old_scores_stay_legacy(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp)
            with patch.object(e, 'score_request', zero):
                result = e.score_case(args(), case)
            report = e.build_report(args(), [result], e.receipts_for(args()))
            legacy = json.loads(json.dumps(result))
            for key in ('request_version', 'state_version', 'prompt_version'):
                legacy.pop(key)
            rerendered = self.rerender_into(tmp, e.build_report(args(), [legacy], {}),
                                            case, 0.1)
        self.assertEqual(result['request_version'], e.REQUEST_VERSION)
        self.assertEqual(result['state_version'], e.STATE_VERSION)
        self.assertEqual(result['prompt_version'], e.PROMPT_VERSION)
        self.assertEqual(result['receipt']['model_visible']['request_version'],
                         e.REQUEST_VERSION)
        self.assertEqual(report['request_version'], e.REQUEST_VERSION)
        self.assertEqual(report['receipts']['request_version'], e.REQUEST_VERSION)
        # A frozen v1 measurement is never relabelled as this revision.
        self.assertIsNone(rerendered['request_version'])
        self.assertFalse(rerendered['request_version_current'])

    def test_rerender_keep_all_recomputes_removal_totals(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp)
            with patch.object(e, 'score_request', zero):
                result = e.score_case(args(), case)
            report = e.build_report(args(), [result], {})
            self.assertGreater(report['totals']['cases_with_removals'], 0)
            updated = self.rerender_into(tmp, report, case, 0.0)
        self.assertEqual(updated['totals']['cases_with_removals'], 0)
        self.assertEqual(updated['totals']['removed_share_of_unprotected_tokens'], 0)
        self.assertEqual(updated['totals']['removed'], 0)

    def test_prompt_does_not_authorize_redundancy_drops(self):
        """No sibling is a guaranteed witness, so a block may not be dropped as redundant."""
        instructions = e.PROMPTS['v2'][1]
        self.assertNotIn('already shows', instructions)
        self.assertIn('no sibling is a witness', instructions)
        payload = e.batch_request({'context': 'c', 'call': {}},
                                  e.plan_blocks(grouped_body()), [])
        self.assertEqual(set(payload['state']),
                         {'recent_user_context', 'tool_call', 'candidate_tool_output'})
        self.assertEqual(set(payload['state']['candidate_tool_output']), {'blocks'})

    def test_prompt_choice_changes_the_recorded_request_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp)
            with patch.object(e, 'score_request', zero):
                old = e.score_case(args(prompt='v1'), case)
                new = e.score_case(args(prompt='v2'), case)
        self.assertEqual(old['prompt_version'], 'keep-prompt-v1')
        self.assertEqual(new['prompt_version'], 'keep-prompt-v2')
        self.assertNotEqual(old['request_version'], new['request_version'])
        self.assertEqual(old['receipt']['model_visible']['instructions_sha256'],
                         e.digest(e.PROMPTS['v1'][1]))
        self.assertEqual(new['request_version'], e.REQUEST_VERSION)

    def rerender_into(self, folder, result, case, threshold):
        result_path = Path(folder) / 'result.json'
        cases_path = Path(folder) / 'cases.json'
        out = Path(folder) / 'rerender.json'
        result_path.write_text(json.dumps(result))
        cases_path.write_text(json.dumps({'cases': [case]}))
        with contextlib.redirect_stdout(io.StringIO()):
            e.rerender(SimpleNamespace(result=str(result_path), cases=str(cases_path),
                                       threshold=threshold, out=str(out)))
        return json.loads(out.read_text())


class PacketContextTests(unittest.TestCase):
    def build_packet(self, folder, result, case):
        result_path = Path(folder) / 'result.json'
        cases_path = Path(folder) / 'cases.json'
        out = Path(folder) / 'packet'
        result_path.write_text(json.dumps(result))
        cases_path.write_text(json.dumps({'cases': [case]}))
        with contextlib.redirect_stdout(io.StringIO()):
            bp.build(SimpleNamespace(results=[str(result_path)], cases=str(cases_path),
                                     out=str(out), count=1, seed=7,
                                     max_case_tokens=20000, require_removal=False,
                                     intact_control=False))
        return out

    def test_long_call_is_kept_intact_and_packet_uses_recorded_input(self):
        marker = 'LONG_CALL_MARKER_' + ('x' * 6000)
        request = call({'command': marker})
        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp, call=request, output=evidence_body())
            with patch.object(e, 'score_request', zero):
                result = e.score_case(args(), case)
            root = self.build_packet(tmp, e.build_report(args(), [result], {}), case)
            context_md = (root / 'packet' / 'case-001' / 'context.md').read_text()
            manifest = json.loads((root / 'packet-manifest.json').read_text())
        self.assertIn(marker, context_md)
        self.assertIn('Exact input recorded', context_md)
        self.assertIn('Reviewer enrichment is not included', context_md)
        self.assertEqual(manifest['cases'][0]['context_source'], 'recorded')
        self.assertNotIn('test/shared-state', context_md)

    def test_old_result_is_labeled_legacy_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = evidence_session(tmp)
            with patch.object(e, 'score_request', zero):
                result = e.score_case(args(), case)
            legacy = json.loads(json.dumps(result))
            legacy.pop('context', None)
            legacy.pop('context_version', None)
            root = self.build_packet(tmp, e.build_report(args(), [legacy], {}), case)
            context_md = (root / 'packet' / 'case-001' / 'context.md').read_text()
            manifest = json.loads((root / 'packet-manifest.json').read_text())
        self.assertIn('LEGACY CONTEXT', context_md)
        self.assertIn('STALE MANIFEST CONTEXT', context_md)
        self.assertEqual(manifest['cases'][0]['context_source'], 'legacy')
        self.assertFalse(manifest['cases'][0]['reviewer_enrichment_included'])


class ContextCensusTests(unittest.TestCase):
    def test_census_is_metadata_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            good = write_session(tmp, ['Fix the parser.'], call({'path': 'a.py'}),
                                 words(60, 'good'), name='good.jsonl')
            bad = write_session(
                tmp, ['# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>\np\n'],
                call({'path': 'b.py'}, call_id='call-2'), words(60, 'bad'),
                name='bad.jsonl')
            cases = Path(tmp) / 'cases.json'
            cases.write_text(json.dumps({'cases': [good, bad]}))
            with patch.object(e, 'score_request') as scorer, \
                    contextlib.redirect_stdout(io.StringIO()):
                payload = e.context_census(SimpleNamespace(cases=str(cases), out=None))
                scorer.assert_not_called()
        self.assertEqual(payload['cases'], 2)
        self.assertEqual(payload['counts']['available'], 1)
        self.assertEqual(payload['counts']['missing_goal'], 1)
        self.assertFalse(payload['manifest_context_used_as_verified'])


if __name__ == '__main__':
    unittest.main()
