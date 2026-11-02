import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import evaluate as ev
import line_experiment as le

class ExecutionReceiptsTest(unittest.TestCase):
    def test_dispatch_provenance_is_invocation_local(self):
        model = SimpleNamespace(info=lambda: {'model': 'fake'}, decide_request=lambda payload:
            SimpleNamespace(truncated=False, to_wire=lambda: {'answers': {
                q: {'noul': 0.9} for q in payload['questions']}, 'usage': {}}))
        runtime = SimpleNamespace(load=Mock(return_value=model))
        cases = le.control_cases()[:1]
        with tempfile.TemporaryDirectory() as tmp, \
                patch.dict('sys.modules', {'mlx_decision': runtime,
                    'mlx': SimpleNamespace(core=SimpleNamespace(__version__='test')),
                    'mlx.core': SimpleNamespace(__version__='test')}), \
                patch('importlib.metadata.version', return_value='test'), \
                patch.object(ev, '_LOADED', None):
            root = Path(tmp)
            manifest = le.freeze_edits(cases, ['d1-3B'], root / 'frozen')
            a = le.args_for_edits(manifest, 'd1-3B', None)
            def run(**kwargs):
                return le.run_edits(manifest, cases, a, root / 'run',
                                    frozen_sha256='same', **kwargs)
            first, second = run(), run()
            self.assertEqual(runtime.load.call_count, 1)
            self.assertEqual(second['execution']['dispatches'], 1)
            self.assertEqual(second['execution']['status'], 'attested')
            self.assertEqual(second['execution']['runtime']['source'], a.model_path)
            summary = le.compare_edits([second], root / 'summary')
            self.assertEqual(summary['execution_comparison']['status'], 'comparable')
            self.assertEqual(summary['models'][0]['execution'], second['execution'])
            synthetic = run(scorer=lambda a, p: ({q: 0.9 for q in p['questions']}, 0, {}))
            self.assertIsNone(synthetic['execution']['runtime'])
            self.assertEqual(synthetic['execution']['status'], 'not-executed')
            with patch.object(ev, 'load_mlx', return_value=model):
                patched = run()
            self.assertIsNone(patched['execution']['runtime'])
            self.assertEqual(patched['execution']['status'], 'unattested')
            original_limit = a.max_tokens
            a.max_tokens = 1
            preflight = run()
            self.assertEqual(preflight['execution']['dispatches'], 0)
            self.assertIsNone(preflight['execution']['runtime'])
            a.max_tokens = original_limit
            a.model_path = '/missing'
            runtime.load.side_effect = FileNotFoundError('missing')
            failed = run()
            self.assertIsNone(failed['execution']['runtime'])
            self.assertEqual(failed['execution']['dispatches'], 0)
            self.assertEqual(first['execution'], second['execution'])
            legacy = copy.deepcopy(first)
            legacy.pop('execution')
            self.assertEqual(le.compare_edits([legacy], root / 'summary')
                             ['execution_comparison']['status'], 'unverified')
            incompatible = copy.deepcopy(first)
            incompatible['execution']['version'] = 'unknown'
            self.assertEqual(ev.compare_execution([incompatible])['status'], 'unverified')
            moved = copy.deepcopy(first)
            moved['execution']['machine']['cpu_cores'] = -1
            self.assertFalse(ev.compare_execution([first, moved])['timing_comparable'])
            mismatch = copy.deepcopy(first)
            mismatch['execution']['runtime']['source'] = 'wrong'
            with self.assertRaisesRegex(ValueError, 'source'):
                le.compare_edits([mismatch], root / 'summary')
            changed = copy.deepcopy(first)
            changed['model'] = 'd1-8B'
            changed['execution']['requested']['model'] = 'd1-8B'
            changed['model_path'] = None
            changed['execution']['requested']['model_path'] = None
            changed['execution']['runtime']['source'] = 'd1-8B'
            changed['execution']['requested']['timeout'] += 1
            comparison = ev.compare_execution([first, changed])
            self.assertEqual(comparison['status'], 'different-controls')
            self.assertIn('requested.timeout', comparison['differences'])

    def test_no_dispatch_has_no_runtime(self):
        a = SimpleNamespace(backend='mlx', model='fake', model_path=None)
        local = ev.execution_args(a)
        receipt = ev.execution_receipt(local)
        self.assertEqual(receipt['status'], 'not-executed')
        self.assertIsNone(receipt['runtime'])
        self.assertFalse(hasattr(a, '_execution'))

    def test_http_dispatch_is_unattested(self):
        a = ev.execution_args(SimpleNamespace(backend='http', model='fake', model_path=None,
            endpoint='http://localhost', key_env=None, timeout=10, max_tokens=1000))
        response = io.BytesIO(json.dumps({'answers': {'q': {'noul': 0.9}}}).encode())
        response.headers = {}
        with patch.object(ev, '_local_http_open', return_value=response):
            ev.score_request(a, {'state': {}, 'questions': {'q': {}}})
        receipt = ev.execution_receipt(a)
        self.assertEqual(receipt['dispatches'], 1)
        self.assertEqual(receipt['status'], 'unattested')
        self.assertIsNone(receipt['runtime'])

    def test_refused_options_and_block_receipt_snapshot(self):
        from test_evaluate import args
        model = SimpleNamespace(info=lambda: {'model': 'fake'}, decide_request=lambda payload:
            SimpleNamespace(truncated=False, to_wire=lambda: {'answers': {'q': {'noul': 0.9}}}))
        runtime = SimpleNamespace(load=Mock(side_effect=[TypeError('prefix_cache_gb'), model]))
        a = ev.execution_args(args(model='fake', model_path=None, prefix_cache_gb=2,
                                  max_input_tokens=0, noul_floor=None))
        with patch.dict('sys.modules', {'mlx_decision': runtime}), \
                patch('importlib.metadata.version', return_value='test'), \
                patch.object(ev, '_LOADED', None):
            ev.score_request(a, {'state': {}, 'questions': {'q': {}}})
            receipt = ev.receipts_for(a)
            self.assertEqual(receipt['runtime']['load_options_requested'], {'prefix_cache_gb': 2})
            self.assertEqual(receipt['runtime']['load_options_applied'], {})
            self.assertEqual(receipt['runtime']['load_options_refused'], ['prefix_cache_gb'])
            receipt['runtime']['info']['model'] = 'changed'
            self.assertEqual(ev.receipts_for(a)['runtime']['info']['model'], 'fake')
            self.assertIsNone(ev.receipts_for(ev.execution_args(a))['runtime'])
