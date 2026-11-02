import email.message
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import evaluate as e


def args(**over):
    base = dict(policy='decision', threshold=0.1, batch='per-block', batch_questions=32, batch_tokens=32000,
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
        with patch.object(e, '_local_http_open') as network:
            with self.assertRaises(e.Failure) as ctx:
                e.http_score(args(max_tokens=40), {'state': 'x' * 400, 'questions': {}})
            network.assert_not_called()
        self.assertEqual(ctx.exception.kind, 'oversize')
        with patch.object(e, 'load_mlx') as loader:
            with self.assertRaises(e.Failure) as ctx:
                e.mlx_score(args(max_tokens=40), {'state': 'x' * 400, 'questions': {}})
            loader.assert_not_called()
        self.assertEqual(ctx.exception.kind, 'oversize')
        self.assertFalse(ctx.exception.request_sent)

    def test_invalid_probability_rejected_and_timed(self):
        for fake in [{'answers': {'keep': {'noul': 2}}},
                     {'answers': {}},
                     {'answers': {'other': {'noul': 0.9}}},
                     {'answers': {'keep': {'noul': 0.0}, 'other': {'noul': 0.9}}},
                     *({'answers': {'keep': {'noul': value}}}
                       for value in (True, '0.0', None, float('nan'), float('inf'), -1)),
                     [], None,
                     '{"answers":{"keep":{"noul":1,"noul":0}}}',
                     '{"answers":{"keep":{"noul":1},"keep":{"noul":0}}}']:
            with self.subTest(response=fake), \
                    patch.object(e, '_local_http_open') as network:
                wire = fake if isinstance(fake, str) else json.dumps(fake)
                network.return_value.__enter__.return_value.read.return_value = wire.encode()
                with self.assertRaises(e.Failure) as ctx:
                    e.http_score(args(), {'state': 'goal', 'questions': {'keep': {}}})
                self.assertEqual(ctx.exception.kind, 'invalid_response')
                self.assertGreater(ctx.exception.elapsed_ms, 0)

    def test_http_runtime_truncation_rejects_otherwise_valid_scores(self):
        with patch.object(e, '_local_http_open') as network, \
                patch.object(e.time, 'perf_counter', side_effect=[1.0, 1.025]):
            response = network.return_value.__enter__.return_value
            response.headers = {'X-MLX-Decision-Truncated': 'true'}
            response.read.return_value = json.dumps(
                {'answers': {'keep': {'noul': 0.0}}}).encode()
            with self.assertRaises(e.Failure) as ctx:
                e.http_score(args(), {'state': 'goal', 'questions': {'keep': {}}})
        self.assertEqual(ctx.exception.kind, 'oversize')
        self.assertAlmostEqual(ctx.exception.elapsed_ms, 25.0)

    def test_timeout_keeps_real_elapsed_time(self):
        for failure in (TimeoutError('read timed out'),
                        e.urllib.error.URLError(TimeoutError('connect timed out'))):
            with self.subTest(failure=failure), \
                    patch.object(e, '_local_http_open', side_effect=failure), \
                    patch.object(e.time, 'perf_counter', side_effect=[1.0, 1.05]):
                with self.assertRaises(e.Failure) as ctx:
                    e.http_score(args(), {'state': 'goal', 'questions': {}})
            self.assertEqual(ctx.exception.kind, 'timeout')
            self.assertAlmostEqual(ctx.exception.elapsed_ms, 50.0)

    def test_http_loopback_cannot_use_a_proxy_or_follow_a_redirect(self):
        def response(code=200, location=None):
            headers = email.message.Message()
            if location:
                headers['Location'] = location
            result = e.urllib.response.addinfourl(
                io.BytesIO(b'{"answers":{"keep":{"noul":0.0}}}'), headers,
                'http://localhost/v1/systemone', code)
            result.msg = 'OK'
            return result

        for redirect in (False, True):
            hosts = []

            def send(handler, request):
                hosts.append(request.host)
                if redirect and len(hosts) == 1:
                    return response(302, 'http://outside.example/collect')
                return response()

            with self.subTest(redirect=redirect), \
                    patch.object(e.urllib.request, '_opener', None), \
                    patch.object(e.urllib.request, 'getproxies',
                                 return_value={} if redirect else {'http': 'http://proxy.example:8080'}), \
                    patch.object(e.urllib.request, 'proxy_bypass', return_value=False), \
                    patch.object(e.urllib.request.HTTPHandler, 'http_open', send):
                if redirect:
                    with self.assertRaises(e.Failure) as ctx:
                        e.http_score(args(), {'state': 'private context', 'questions': {'keep': {}}})
                    self.assertEqual(ctx.exception.kind, 'unsupported')
                else:
                    scores, _, _ = e.http_score(
                        args(), {'state': 'private context', 'questions': {'keep': {}}})
                    self.assertEqual(scores, {'keep': 0.0})
            self.assertEqual(hosts, ['localhost'])

    def test_mlx_load_failure_is_timed_without_claiming_inference(self):
        with patch.object(e, 'load_mlx', side_effect=ImportError('runtime unavailable')), \
                patch.object(e.time, 'perf_counter', side_effect=[1.0, 1.02]):
            with self.assertRaises(e.Failure) as ctx:
                e.mlx_score(args(), {'state': 'goal', 'questions': {'keep': {}}})
        self.assertEqual(ctx.exception.kind, 'unavailable')
        self.assertFalse(ctx.exception.request_sent)
        self.assertAlmostEqual(ctx.exception.elapsed_ms, 20.0)

    def test_mlx_cache_tracks_model_and_load_options(self):
        models = [SimpleNamespace(info=lambda name=name: {'name': name}) for name in ('a', 'b', 'c')]
        runtime = SimpleNamespace(load=Mock(side_effect=models))
        base = dict(model_path=None, prefix_cache_gb=2.0, max_input_tokens=0, noul_floor=0.0)
        with patch.dict('sys.modules', {'mlx_decision': runtime}), \
                patch('importlib.metadata.version', return_value='test'), \
                patch.object(e, '_MODEL', None), patch.object(e, '_MODEL_RECEIPT', {}), \
                patch.object(e, '_MODEL_CONFIG', None):
            self.assertIs(e.load_mlx(args(model='a', **base)), models[0])
            self.assertIs(e.load_mlx(args(model='a', **base)), models[0])
            self.assertIs(e.load_mlx(args(model='b', **base)), models[1])
            self.assertIs(e.load_mlx(args(model='b', **{**base, 'max_input_tokens': 1000})), models[2])
            self.assertEqual(runtime.load.call_count, 3)
            self.assertEqual(e._MODEL_RECEIPT['source'], 'b')
            self.assertEqual(e._MODEL_RECEIPT['load_options_applied']['max_input_tokens'], 1000)

    def test_shared_state_maps_one_question_per_block(self):
        seen = []

        def fake(a, payload):
            seen.append(payload)
            return ({qid: (0.9 if qid != 'b1' else 0.01) for qid in payload['questions']}, 2.0, {})

        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY)
            with patch.object(e, 'score_request', fake):
                result = e.score_case(args(batch='shared-state', batch_questions=64, batch_tokens=24000), case)
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

    def test_http_model_field_counts_toward_budget_and_receipts(self):
        seen = []

        def fake(a, payload):
            seen.append(payload)
            return {qid: 0.0 for qid in payload['questions']}, 1.0, {}

        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY)
            options = args(backend='http', model='local-model-name-' * 20,
                           batch='shared-state', batch_questions=64, batch_tokens=50000)
            with patch.object(e, 'score_request', fake):
                result = e.score_case(options, case)
            self.assertEqual(result['batches'][0]['request_tokens'],
                             e.tokens(json.dumps({**seen[0], 'model': options.model})))
            base = dict(seen[0])
            base['questions'] = dict(list(base['questions'].items())[:1])
            for mode in ('per-block', 'shared-state'):
                with self.subTest(mode=mode), patch.object(e, 'score_request') as scorer:
                    result = e.score_case(args(backend='http', model=options.model,
                                               batch=mode, batch_tokens=e.request_tokens(base)), case)
                    scorer.assert_not_called()
                self.assertEqual(result['requests'], 0)
                self.assertEqual(result['after'], result['before'])

    def test_http_timeout_respects_remaining_case_deadline(self):
        captured = []

        def respond(request, timeout):
            captured.append(timeout)
            questions = json.loads(request.data)['questions']
            response = io.BytesIO(json.dumps(
                {'answers': {q: {'noul': 0.0} for q in questions}}).encode())
            response.headers = {}
            return response

        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY)
            with patch.object(e, '_local_http_open', respond), \
                    patch.object(e.time, 'perf_counter', return_value=0.0):
                result = e.score_case(args(backend='http', batch='shared-state',
                                           batch_questions=64, batch_tokens=50000,
                                           max_tokens=50000, deadline_ms=40), case)
        self.assertEqual(captured, [0.04])
        self.assertEqual(result['statuses'], {'ok': 1})
        oversize = e.oversize
        for backend in ('http', 'mlx'):
            clock = [0.0]

            def delayed_preflight(*a):
                size = oversize(*a)
                clock[0] = 0.05
                return size

            with self.subTest(backend=backend), \
                    patch.object(e.time, 'perf_counter', side_effect=lambda: clock[0]), \
                    patch.object(e, 'oversize', delayed_preflight), \
                    patch.object(e, '_local_http_open', side_effect=respond) as network, \
                    patch.object(e, 'load_mlx') as loader:
                loader.return_value.decide_request.return_value = SimpleNamespace(
                    truncated=False, to_wire=lambda: {'answers': {'keep': {'noul': 0.0}}})
                with self.assertRaises(e.Failure) as ctx:
                    e.score_request(args(backend=backend, _deadline_at=0.04),
                                    {'state': 'goal', 'questions': {'keep': {}}})
                self.assertEqual(ctx.exception.kind, 'deadline')
                self.assertFalse(ctx.exception.request_sent)
                network.assert_not_called()
                loader.return_value.decide_request.assert_not_called()

    def test_source_change_during_inference_refuses_measurement(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY)

            def mutate(a, payload):
                path = Path(case['source'])
                path.write_text(path.read_text().replace('Goal: fix the parser', 'Keep every source line'))
                return {q: 0.0 for q in payload['questions']}, 0.0, {}

            with patch.object(e, 'score_request', mutate), \
                    patch.object(e, 'apply_incoming') as apply:
                with self.assertRaisesRegex(ValueError, 'Source changed during evaluation'):
                    e.score_case(args(batch='shared-state', batch_questions=64,
                                      batch_tokens=50000), case)
                apply.assert_not_called()

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
        clock = [0.0]

        def slow(a, payload):
            clock[0] += 0.03
            return {qid: 0.0 for qid in payload['questions']}, 30.0, {}

        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY)
            with patch.object(e, 'score_request', slow), \
                    patch.object(e.time, 'perf_counter', side_effect=lambda: clock[0]):
                result = e.score_case(args(batch='shared-state', batch_questions=2, deadline_ms=40), case)
        self.assertTrue(result['deadline_abstain'])
        self.assertEqual(result['after'], result['before'])
        self.assertTrue(all(d['effective'] == 'keep' for d in result['decisions']))
        self.assertTrue(any(d['reason'] == 'abstain: deadline' or d['reason'] == 'model score'
                            for d in result['decisions']))

    def test_deadline_after_last_group_still_abstains(self):
        clock = [0.0]

        def slow(a, payload):
            clock[0] += 0.05
            return {qid: 0.0 for qid in payload['questions']}, 50.0, {}

        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY)
            with patch.object(e, 'score_request', slow), \
                    patch.object(e.time, 'perf_counter', side_effect=lambda: clock[0]):
                result = e.score_case(args(batch='shared-state', batch_questions=64,
                                           batch_tokens=24000, deadline_ms=40), case)
        self.assertTrue(result['deadline_abstain'])
        self.assertEqual(result['after'], result['before'])
        self.assertEqual(result['statuses'].get('ok'), 1)

    def test_context_reconstruction_counts_toward_case_deadline(self):
        clock = [0.0]
        reconstruct = e.causal_for_case

        def slow_context(case):
            context = reconstruct(case)
            clock[0] += 0.05
            return context

        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY)
            with patch.object(e, 'causal_for_case', slow_context), \
                    patch.object(e, 'score_request',
                                 lambda a, p: ({q: 0.0 for q in p['questions']}, 0.0, {})), \
                    patch.object(e.time, 'perf_counter', side_effect=lambda: clock[0]):
                result = e.score_case(args(batch='shared-state', deadline_ms=40), case)
        self.assertTrue(result['deadline_abstain'])
        self.assertEqual(result['requests'], 0)
        self.assertEqual(result['after'], result['before'])
        self.assertEqual(result['latency_ms'], 50.0)

    def test_deadline_covers_request_encoding_and_selection_rendering(self):
        for stage in ('encoding', 'rendering'):
            clock = [0.0]
            encode, render = e.request_tokens, e.resolution

            def slow_encode(payload, model=None):
                value = encode(payload, model)
                if stage == 'encoding':
                    clock[0] = 0.05
                return value

            def slow_render(*a, **k):
                outcome = render(*a, **k)
                if stage == 'rendering':
                    clock[0] = 0.05
                return outcome

            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as tmp:
                case = write_case(tmp, BODY)
                with patch.object(e, 'score_request',
                                  lambda a, p: ({q: 0.0 for q in p['questions']}, 0.0, {})), \
                        patch.object(e, 'request_tokens', slow_encode), \
                        patch.object(e, 'resolution', slow_render), \
                        patch.object(e.time, 'perf_counter', side_effect=lambda: clock[0]):
                    result = e.score_case(args(batch='shared-state', batch_questions=64,
                                               batch_tokens=0, deadline_ms=40), case)
            self.assertTrue(result['deadline_abstain'])
            self.assertEqual(result['guard'], 'deadline')
            self.assertEqual(result['after'], result['before'])
            self.assertTrue(all(d['effective'] == 'keep' for d in result['decisions']))
            if stage == 'encoding':
                self.assertEqual(result['requests'], 0)

    def test_proposed_drops_survive_non_expansion_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = write_case(tmp, BODY)
            with patch.object(e, 'score_request', lambda a, p: ({q: 0.0 for q in p['questions']}, 1.0, {})):
                result = e.score_case(args(batch='shared-state', batch_questions=64, batch_tokens=24000), case)
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
        for wrapper in [
            '  { "output" : "a\\nb\\nc", "exit_code": 0, "elapsed": 1e-4, '
            '"label": "\\u0061", "event": 1, "event": 2 }\n',
            '{"meta": {"output": "untouched"}, "out\\u0070ut": "a\\nb\\nc"}',
        ]:
            with self.subTest(wrapper=wrapper):
                leaves = text_leaves(wrapper)
                self.assertEqual(leaves, [(['json', 'output'], 'a\nb\nc')])
                self.assertEqual(replace_leaf(wrapper, leaves[0][0], 'a\nc'),
                                 wrapper.replace('"a\\nb\\nc"', '"a\\nc"'))


if __name__ == '__main__':
    unittest.main()
