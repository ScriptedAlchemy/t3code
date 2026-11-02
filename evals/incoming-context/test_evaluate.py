import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import evaluate as e


def args(**over):
    base = dict(policy='decision', threshold=0.1, batch='per-block', batch_questions=32, batch_tokens=8000,
                deadline_ms=0, max_tokens=7500, backend='mlx', timeout=60.0, model='test',
                key_env=None, endpoint='http://localhost')
    base.update(over)
    return SimpleNamespace(**base)


def write_case(folder, body, blocks=1):
    path = Path(folder) / 'rollout.jsonl'
    output = body if blocks == 1 else [
        {'type': 'input_text', 'text': body[:len(body) // 2]},
        {'type': 'input_text', 'text': body[len(body) // 2:]},
    ]
    lines = [
        {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user',
                                              'content': [{'type': 'input_text', 'text': 'Goal: fix the parser'}]}},
        {'type': 'response_item', 'payload': {'type': 'function_call', 'call_id': 'abc',
                                              'name': 'read', 'arguments': '{"path":"parser.py"}'}},
        {'type': 'response_item', 'payload': {'type': 'function_call_output', 'call_id': 'abc',
                                              'status': 'completed', 'output': output}},
    ]
    path.write_text('\n'.join(json.dumps(line) for line in lines) + '\n')
    lines_text = e.text(output)
    return {'id': 'case-0001', 'source': str(path), 'line': 3, 'split': 'development',
            'sha256': e.digest(lines_text), 'context': 'Goal: fix the parser',
            'call': {'name': 'read', 'arguments': '{"path":"parser.py"}'},
            'original_tokens': e.tokens(lines_text)}


BODY = ''.join(f'    line_{i} = compute("value_{i}", target_{i}, checksum_{i})\n' for i in range(800))


class EvaluatorTests(unittest.TestCase):
    def test_images_excluded(self):
        self.assertEqual(e.text([{'type': 'input_text', 'text': 'hi'},
                                 {'type': 'input_image', 'image_url': 'secret'}]), 'hi\n')

    def test_chunks_preserve_exact_bytes_and_order(self):
        raw = 'fn main() {\n' + ('    let variable = 123;\n' * 500) + '}\n'
        self.assertEqual(''.join(e.chunks(raw)), raw)
        self.assertGreater(len(e.chunks(raw)), 1)

    def test_request_has_no_future(self):
        c = {'context': 'current request', 'call': {'name': 'read'}, 'future': 'secret answer'}
        self.assertNotIn('future', str(e.request(c, 'data')))
        self.assertNotIn('secret answer', str(e.request(c, 'data')))

    def test_oversize_refused_before_network(self):
        with patch.object(e.urllib.request, 'urlopen') as network:
            with self.assertRaises(e.Failure) as ctx:
                e.http_score(args(max_tokens=40), {'state': 'x' * 400, 'questions': {}})
            network.assert_not_called()
        self.assertEqual(ctx.exception.kind, 'oversize')

    def test_invalid_probability_rejected_and_timed(self):
        fake = {'answers': {'keep': {'noul': 2}}}
        with patch.object(e.urllib.request, 'urlopen') as network:
            network.return_value.__enter__.return_value.read.return_value = json.dumps(fake).encode()
            with self.assertRaises(e.Failure) as ctx:
                e.http_score(args(), {'state': 'goal', 'questions': {}})
        self.assertEqual(ctx.exception.kind, 'invalid_response')
        self.assertGreater(ctx.exception.elapsed_ms, 0)

    def test_timeout_keeps_real_elapsed_time(self):
        def slow(*a, **k):
            time.sleep(0.05)
            raise TimeoutError('read timed out')
        with patch.object(e.urllib.request, 'urlopen', slow):
            with self.assertRaises(e.Failure) as ctx:
                e.http_score(args(), {'state': 'goal', 'questions': {}})
        self.assertEqual(ctx.exception.kind, 'timeout')
        self.assertGreaterEqual(ctx.exception.elapsed_ms, 40)

    def test_shared_state_maps_one_question_per_block(self):
        seen = []

        def fake(a, payload):
            seen.append(payload)
            return ({qid: (0.9 if qid != 'b1' else 0.01) for qid in payload['questions']}, 2.0, {})

        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY)
            with patch.object(e, 'score_request', fake):
                result = e.score_case(args(batch='shared-state', batch_questions=64, batch_tokens=20000), case)
        self.assertEqual(len(seen), 1)
        self.assertEqual(len(seen[0]['questions']), result['scored_blocks'])
        self.assertEqual(result['decisions'][1]['effective'], 'drop')
        self.assertEqual(result['decisions'][0]['effective'], 'keep')
        self.assertEqual(result['decisions'][0]['reason'], 'protected boundary or diagnostic')
        self.assertLess(result['after'], result['before'])
        self.assertFalse(result['historical_content_rewritten'])
        self.assertEqual(result['receipt']['prefix_bytes'] > 0, True)

    def test_batch_groups_respect_question_limit(self):
        seen = []

        def fake(a, payload):
            seen.append(len(payload['questions']))
            return {qid: 1.0 for qid in payload['questions']}, 1.0, {}

        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY)
            with patch.object(e, 'score_request', fake):
                result = e.score_case(args(batch='shared-state', batch_questions=4), case)
        self.assertTrue(all(n <= 4 for n in seen))
        self.assertGreater(len(seen), 1)
        self.assertEqual(sum(seen), result['scored_blocks'])

    def test_failure_abstains_and_keeps_original(self):
        def broken(a, payload):
            raise e.Failure('timeout', 'read timed out', 12.5)

        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY)
            with patch.object(e, 'score_request', broken):
                result = e.score_case(args(batch='shared-state'), case)
        self.assertEqual(result['after'], result['before'])
        self.assertTrue(all(d['effective'] == 'keep' for d in result['decisions']))
        self.assertEqual(set(result['statuses']), {'timeout'})

    def test_deadline_reverts_whole_result(self):
        def slow(a, payload):
            time.sleep(0.03)
            return {qid: 0.0 for qid in payload['questions']}, 30.0, {}

        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY)
            with patch.object(e, 'score_request', slow):
                result = e.score_case(args(batch='shared-state', batch_questions=2, deadline_ms=40), case)
        self.assertTrue(result['deadline_abstain'])
        self.assertEqual(result['after'], result['before'])
        self.assertTrue(all(d['effective'] == 'keep' for d in result['decisions']))
        self.assertTrue(any(d['reason'] == 'abstain: deadline' or d['reason'] == 'model score'
                            for d in result['decisions']))

    def test_deadline_after_last_group_still_abstains(self):
        def slow(a, payload):
            time.sleep(0.03)
            return {qid: 0.0 for qid in payload['questions']}, 30.0, {}

        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY)
            with patch.object(e, 'score_request', slow):
                result = e.score_case(args(batch='shared-state', batch_questions=64,
                                           batch_tokens=20000, deadline_ms=40), case)
        self.assertTrue(result['deadline_abstain'])
        self.assertEqual(result['after'], result['before'])
        self.assertEqual(result['statuses'].get('ok'), 1)

    def test_proposed_drops_survive_non_expansion_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY)
            with patch.object(e, 'score_request', lambda a, p: ({q: 0.0 for q in p['questions']}, 1.0, {})):
                result = e.score_case(args(batch='shared-state', batch_questions=64, batch_tokens=20000), case)
        # Dropping every unprotected block cannot expand the result, so the guard stays out of it.
        self.assertIsNone(result['guard'])
        self.assertLess(result['after'], result['before'])


class PacketTests(unittest.TestCase):
    def test_packet_retention_matches_measured_after(self):
        import blind_packet as bp
        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY, blocks=2)
            with patch.object(e, 'score_request',
                              lambda a, p: ({q: (0.0 if q in ('b1', 'b4') else 0.9)
                                             for q in p['questions']}, 1.0, {})):
                result = e.score_case(args(batch='shared-state', batch_questions=64,
                                           batch_tokens=20000), case)
            dropped = {d['block'] for d in result['decisions'] if d['effective'] == 'drop'}
            self.assertTrue(dropped)
            _, kept = bp.kept_output(case, dropped)
            self.assertEqual(e.tokens(kept), result['after'])


class IncomingTests(unittest.TestCase):
    def test_prefix_and_tool_linkage_unchanged(self):
        from incoming import apply_incoming
        prefix = b'  {"cached":"exact bytes", "order":1}\n'
        incoming = {'type': 'function_call_output', 'call_id': 'abc', 'output': 'long result',
                    'status': 'completed'}
        before = repr(incoming)
        returned, selected, receipt = apply_incoming(prefix, incoming, 'short')
        self.assertIs(returned, prefix)
        self.assertEqual(returned, prefix)
        self.assertEqual(repr(incoming), before)
        self.assertEqual(selected['call_id'], 'abc')
        self.assertEqual(selected['status'], 'completed')
        self.assertFalse(receipt['old_prefix_changed'])
        self.assertEqual(receipt['prefix_sha256'], receipt['prefix_sha256_after'])
        self.assertEqual(receipt['envelope_sha256_before'], receipt['envelope_sha256_after'])

    def test_non_tool_messages_cannot_be_pruned(self):
        from incoming import apply_incoming
        with self.assertRaises(ValueError):
            apply_incoming(b'prefix', {'type': 'message', 'role': 'user'}, '')

    def test_json_wrapper_and_images_preserved(self):
        from incoming import text_leaves, replace_leaf
        value = [{'type': 'input_text', 'text': '{"output":"a\\nb\\nc", "exit_code":0}'},
                 {'type': 'input_image', 'image_url': 'opaque'}]
        leaves = text_leaves(value)
        self.assertEqual(leaves, [([0, 'text', 'json', 'output'], 'a\nb\nc')])
        changed = replace_leaf(value, leaves[0][0], 'a\nc')
        self.assertEqual(json.loads(changed[0]['text'])['exit_code'], 0)
        self.assertEqual(changed[1], value[1])


if __name__ == '__main__':
    unittest.main()
