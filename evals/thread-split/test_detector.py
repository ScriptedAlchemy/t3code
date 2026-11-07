from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from detector import score_response, summarize
from run import main


class DetectorTest(unittest.TestCase):
    def test_truncation_abstains_even_when_score_would_suggest_split(self):
        response = SimpleNamespace(truncated=True, answers={'q': SimpleNamespace(noul=1.0)})
        self.assertIsNone(score_response(response))
        for invalid in (float('nan'), float('inf'), -0.1, 1.1):
            response = SimpleNamespace(truncated=False, answers={'q': SimpleNamespace(noul=invalid)})
            with self.assertRaises(ValueError):
                score_response(response)

    def test_confusion_counts_include_boundary_and_report_abstentions(self):
        rows = [
            dict(id='switch', label='INDEPENDENT', score=0.94),
            dict(id='followup', label='DEPENDS', score=0.95),
            dict(id='miss', label='INDEPENDENT', score=0.2),
            dict(id='keep', label='DEPENDS', score=0.2),
            dict(id='error', label='INDEPENDENT', score=None),
        ]
        self.assertEqual(summarize(rows, 0.94), dict(tp=1, fp=1, tn=1, fn=1, abstained=1))
        with self.assertRaises(ValueError):
            summarize(rows + rows[:1], 0.94)
        with self.assertRaises(ValueError):
            summarize([dict(id='bad', label='UNKNOWN', score=0.8)], 0.94)

    def test_runner_abstains_before_scoring_short_drafts_only_when_requested(self):
        cases = [dict(id=str(i), session='session', label='INDEPENDENT',
                      state=dict(prior_thread=[], new_message=message))
                 for i, message in enumerate(('run every test now',
                                              'add coverage for cache invalidation',
                                              'add\ufeffcoverage\u00a0for cache invalidation'))]
        for minimum, calls in ((0, 3), (5, 2)):
            with self.subTest(minimum=minimum), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, output = root / 'cases.json', root / 'output'
                source.write_text(json.dumps(cases))
                model = SimpleNamespace(decide_request=Mock(return_value=SimpleNamespace(
                    truncated=False, answers={'q': SimpleNamespace(noul=.98)})))
                argv = ['run.py', '--cases', str(source), '--model', str(root / 'model'),
                        '--threshold', '.6538', '--out', str(output)]
                if minimum:
                    argv += ['--min-message-words', str(minimum)]
                with patch.object(sys, 'argv', argv), patch.dict(sys.modules, {
                    'mlx_decision': SimpleNamespace(load=Mock(return_value=model)),
                }), redirect_stdout(io.StringIO()):
                    main()
                rows = [json.loads(line) for line in (output / 'scores.jsonl').read_text().splitlines()]
                self.assertEqual(model.decide_request.call_count, calls)
                self.assertEqual(rows[0]['score'], None if minimum else .98)
                if minimum:
                    self.assertEqual(rows[0]['abstention'], 'short_message')
                report = json.loads((output / 'summary.json').read_text())
                self.assertEqual(report['counts']['tp'], calls)
                self.assertEqual(report['counts']['abstained'], len(cases) - calls)


if __name__ == '__main__':
    unittest.main()
