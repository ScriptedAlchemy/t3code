"""Behavioural tests for the bounded per-line selection experiment.

Synthetic fixtures only. They establish request shape, guard behaviour, evidence
accounting and the frozen-manifest contract; they establish nothing about
selection quality, real producer provenance or provider billing.
"""
import json
import re
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

import evaluate as ev
import line_experiment as le
import output_lines as ol


def args(**over):
    base = dict(model='d1-3B', model_path=None, backend='mlx', max_tokens=32000,
                timeout=60.0, prefix_cache_gb=None, max_input_tokens=0, noul_floor=None,
                threshold=0.5, tail_lines=8, request_budget=32000, deadline_ms=0)
    base.update(over)
    return SimpleNamespace(**base)


def scorer(keep):
    """A fake runtime: keep probability 1.0 for the named lines, 0.0 for the rest."""
    calls = []

    def score(a, payload):
        calls.append(payload)
        probs = {qid: (1.0 if int(qid[1:]) in keep else 0.0) for qid in payload['questions']}
        return probs, 4.0, {'input_tokens': 1}

    score.calls = calls
    return score


def failing(kind='unavailable'):
    calls = []

    def score(a, payload):
        calls.append(payload)
        raise ev.Failure(kind, 'runtime unavailable', 12.5)

    score.calls = calls
    return score


def decoded(case):
    result, reason = le.check_case(case)
    if result is None:
        raise AssertionError('fixture is not a decoded envelope: ' + reason)
    return result


def tiny_case(output, case_id='tiny'):
    return le.Case(case_id, 'synthetic-log', 'tiny fixture', 'why?', {'name': 'exec'},
                   le._leaf(output, 'tiny-0001', 0))


def wide_case(case_id='wide'):
    """Five long, varied lines: dropping a line saves more than one marker costs."""
    words = ('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima '
             'mike november oscar papa quebec romeo sierra tango uniform victor whiskey').split()
    rows = ['line %d: ' % number + ' '.join(words[(number + i) % len(words)]
                                             for i in range(50))
            for number in range(1, 6)]
    return tiny_case('\n'.join(rows) + '\n', case_id)


def text_lines(case):
    return [line.text for line in decoded(case).lines]


class FixtureTest(unittest.TestCase):
    def test_synthetic_fixtures_decode_and_validate(self):
        cases = le.synthetic_cases()
        self.assertEqual([case.id for case in cases],
                         ['synthetic-build-log', 'synthetic-host-config-review',
                          'synthetic-cpu-search'])
        for case in cases:
            with self.subTest(case=case.id):
                result = decoded(case)
                self.assertGreater(len(result.lines), 10)
                for item in case.evidence:
                    self.assertIn(item.must_contain, text_lines(case)[item.line - 1])

    def test_log_fixture_has_progress_noise_and_a_multiline_cause(self):
        case = le.synthetic_cases()[0]
        lines = text_lines(case)
        progress = [line for line in lines if line.startswith('[') and '%] Building' in line]
        self.assertGreaterEqual(len(progress), 8)
        self.assertTrue(any('linker command failed' in line for line in lines))
        self.assertGreaterEqual(sum('referenced from' in line for line in lines), 2)
        self.assertTrue(any('[cleanup] exit status 0' in line for line in lines))
        self.assertTrue(lines[-1].startswith('build status: FAILED'))

    def test_real_picks_exist_and_are_small(self):
        self.assertEqual([index for _, index in le.REAL_PICKS], [0, 1])
        self.assertEqual(len({case_id for case_id, _ in le.REAL_PICKS}), 2)

    def test_unknown_representation_keeps_the_original(self):
        case = le.Case('odd', 'synthetic-log', 'unknown', 'why?', {'name': 'exec'},
                       'Script completed\nWall time 1.0 seconds\nOutput:\n{"a": 1}')
        self.assertEqual(le.check_case(case), (None, 'not-json'))
        result = le.evaluate_case(case, args(), scorer(set()))
        self.assertFalse(result['recognized'])
        self.assertEqual(result['requests'], [])
        for arm in le.ARMS:
            self.assertEqual(result['arms'][arm]['selected'], 'original')
            self.assertEqual(result['arms'][arm]['abstain']['kind'], 'unknown-representation')

    def test_unknown_representation_cannot_carry_evidence(self):
        case = le.Case('odd', 'synthetic-log', 'unknown', 'why?', {'name': 'exec'},
                       'not an envelope', (le.Evidence(1, 'not an envelope', 'x'),))
        with self.assertRaises(ValueError):
            le.check_case(case)


class RequestShapeTest(unittest.TestCase):
    def setUp(self):
        self.case = le.synthetic_cases()[1]
        self.decoded = decoded(self.case)
        self.plan = le.plan_for(self.decoded)
        self.payload = le.build_request(self.case, self.plan)

    def test_one_question_per_original_line(self):
        expected = {'b%d' % line.number for line in self.decoded.lines}
        self.assertEqual(set(self.payload['questions']), expected)
        self.assertEqual(len(self.payload['questions']), len(self.decoded.lines))

    def test_state_carries_every_line_verbatim_in_order(self):
        blocks = self.payload['state']['candidate_tool_output']['blocks']
        self.assertEqual([block['index'] for block in blocks],
                         [line.number for line in self.decoded.lines])
        self.assertEqual([block['text'] for block in blocks],
                         [line.text for line in self.decoded.lines])

    def test_question_text_is_one_frozen_instruction_per_line(self):
        for qid, question in self.payload['questions'].items():
            with self.subTest(qid=qid):
                self.assertEqual(question['type'], 'noul')
                self.assertEqual(question['instructions'],
                                 le.INSTRUCTIONS.format(index=int(qid[1:])))

    def test_instruction_is_identical_across_cases(self):
        other = le.build_request(le.synthetic_cases()[2], le.plan_for(decoded(
            le.synthetic_cases()[2])))
        self.assertEqual(other['questions']['b1']['instructions'],
                         self.payload['questions']['b1']['instructions'])

    def test_reviewer_annotations_never_enter_the_selector_state(self):
        serialized = json.dumps(self.payload, ensure_ascii=False)
        for item in self.case.evidence:
            self.assertNotIn(item.why, serialized)
        self.assertNotIn('must_contain', serialized)
        self.assertNotIn('required_evidence', serialized)

    def test_causal_context_and_origin_are_the_scored_context(self):
        self.assertEqual(self.payload['state']['recent_user_context'], self.case.context)
        self.assertEqual(self.payload['state']['tool_call'], self.case.call)

    def test_fitting_case_is_exactly_one_request(self):
        groups = ev.group_targets({'context': self.case.context, 'call': self.case.call},
                                  self.plan, self.plan, 32000, len(self.plan),
                                  le.INSTRUCTIONS)
        self.assertEqual(len(groups), 1)
        self.assertEqual(len(groups[0]), len(self.plan))


class ArmRenderingTest(unittest.TestCase):
    def test_allkeep_returns_the_original(self):
        case = le.synthetic_cases()[0]
        result = le.evaluate_case(case, args(), scorer(set()))
        arm = result['arms']['allkeep']
        self.assertEqual(arm['selected'], 'original')
        self.assertEqual(arm['removed_lines'], [])
        self.assertEqual(arm['removed_runs'], 0)
        self.assertEqual(arm['envelope_tokens_after'], arm['envelope_tokens_before'])

    def test_tail_keeps_exactly_the_last_lines(self):
        case = le.synthetic_cases()[0]
        result = le.evaluate_case(case, args(tail_lines=5), scorer(set()))
        arm = result['arms']['tail']
        count = result['lines']
        self.assertEqual(arm['kept_lines'], list(range(count - 4, count + 1)))
        self.assertEqual(arm['removed_runs'], 1)
        self.assertEqual(arm['omissions'][0]['lines'], '1-%d' % (count - 5))

    def test_adjacent_removals_coalesce_into_one_marker(self):
        result = le.evaluate_case(wide_case(), args(), scorer({1, 2, 5}))
        arm = result['arms']['lines']
        self.assertIsNone(arm['guard'])
        self.assertEqual([item['lines'] for item in arm['omissions']], ['3-4'])
        self.assertEqual(arm['omissions'][0]['count'], 2)

    def test_separated_removals_get_one_marker_each(self):
        result = le.evaluate_case(wide_case(), args(), scorer({1, 2, 4, 5}))
        arm = result['arms']['lines']
        self.assertIsNone(arm['guard'])
        self.assertEqual([item['lines'] for item in arm['omissions']], ['3'])

    def test_kept_lines_are_the_exact_original_bytes(self):
        case = le.synthetic_cases()[2]
        result = le.evaluate_case(case, args(), scorer({1, 2, 3}))
        keep = result['arms']['lines']['kept_lines']
        rendered = ol.render(decoded(case), le.kept_ranges(keep))
        self.assertEqual(rendered.kept, tuple(decoded(case).lines[n - 1] for n in keep))

    def test_every_arm_is_non_expanding_including_markers(self):
        for case in le.synthetic_cases():
            result = le.evaluate_case(case, args(), scorer(range(1, 6)))
            for arm in le.ARMS:
                row = result['arms'][arm]
                with self.subTest(case=case.id, arm=arm):
                    self.assertLessEqual(row['envelope_tokens_after'],
                                         row['envelope_tokens_before'])
                    self.assertLessEqual(row['text_tokens_after'], row['text_tokens_before'])

    def test_marker_overhead_keeps_the_original(self):
        case = tiny_case('keep me\nx\n')
        result = le.evaluate_case(case, args(), scorer({1}))
        arm = result['arms']['lines']
        self.assertEqual(arm['guard'], 'non-expansion')
        self.assertEqual(arm['selected'], 'original')
        self.assertEqual(arm['kept_lines'], [1, 2])
        self.assertEqual(arm['removed_lines'], [])
        self.assertEqual(arm['proposed_removed_lines'], [2])
        self.assertGreater(arm['proposed_envelope_tokens'], arm['envelope_tokens_before'])

    def test_keep_lines_uses_the_frozen_threshold_inclusively(self):
        self.assertEqual(le.keep_lines({'b1': 0.5, 'b2': 0.4999}, 0.5), {1})


class RecallTest(unittest.TestCase):
    def test_allkeep_recalls_every_required_line(self):
        case = le.synthetic_cases()[0]
        result = le.evaluate_case(case, args(), scorer(set()))
        self.assertTrue(result['recall']['allkeep']['joint'])
        self.assertEqual(result['recall']['allkeep']['kept'], len(case.evidence))

    def test_dropping_required_evidence_is_visible(self):
        case = le.synthetic_cases()[0]
        dropped = {item.line for item in case.evidence[:5]}
        result = le.evaluate_case(case, args(), scorer(
            {line.number for line in decoded(case).lines} - dropped))
        self.assertIsNone(result['arms']['lines']['guard'])
        value = result['recall']['lines']
        self.assertFalse(value['joint'])
        self.assertTrue(any(item['line'] in dropped and not item['kept']
                            for item in value['items']))

    def test_recall_is_none_without_annotations(self):
        case = tiny_case('alpha\nbeta\n')
        recall = le.evaluate_case(case, args(), scorer({1}))['recall']
        self.assertEqual(set(recall.values()), {None})


class AbstentionTest(unittest.TestCase):
    def test_oversize_sends_nothing_and_records_the_size(self):
        fake = scorer(set())
        result = le.evaluate_case(le.synthetic_cases()[0], args(request_budget=100), fake)
        self.assertEqual(fake.calls, [])
        self.assertEqual(result['requests'], [])
        self.assertEqual(result['arms']['lines']['abstain']['kind'], 'oversize')
        self.assertGreater(result['arms']['lines']['requested_tokens'], 100)
        self.assertEqual(result['arms']['lines']['selected'], 'original')

    def test_unavailable_runtime_keeps_the_original_with_accounting(self):
        fake = failing()
        result = le.evaluate_case(le.synthetic_cases()[0], args(), fake)
        self.assertEqual(len(fake.calls), 1)
        entry = result['requests'][0]
        self.assertEqual(entry['kind'], 'unavailable')
        self.assertEqual(entry['elapsed_ms'], 12.5)
        arm = result['arms']['lines']
        self.assertEqual(arm['abstain']['kind'], 'unavailable')
        self.assertEqual(len(arm['kept_lines']), result['lines'])
        self.assertEqual(arm['removed_lines'], [])

    def test_deadline_skips_scoring(self):
        fake = scorer(set())
        result = le.evaluate_case(le.synthetic_cases()[0], args(deadline_ms=1), fake,
                                  started=time.monotonic() - 1)
        self.assertEqual(fake.calls, [])
        self.assertEqual(result['arms']['lines']['abstain']['kind'], 'deadline')

    def test_missing_answers_keep_the_original(self):
        case = le.synthetic_cases()[2]

        def partial(a, payload):
            return {'b1': 1.0}, 1.0, {}

        result = le.evaluate_case(case, args(), partial)
        self.assertEqual(result['arms']['lines']['abstain']['kind'], 'invalid-response')
        self.assertEqual(len(result['arms']['lines']['kept_lines']), result['lines'])

    def test_empty_output_asks_nothing(self):
        result = le.evaluate_case(tiny_case(''), args(), scorer(set()))
        self.assertEqual(result['requests'], [])
        self.assertEqual(result['arms']['lines']['abstain']['kind'], 'empty-output')


class FreezeRunTest(unittest.TestCase):
    def test_freeze_records_digests_and_a_bounded_plan(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder) / 'frozen.json'
            manifest = le.freeze(le.synthetic_cases(), ('d1-3B', 'pplx-decider-flash-v1.2'), out)
            self.assertEqual(manifest['requests_per_model'], 3)
            self.assertEqual(manifest['requests_total'], 6)
            self.assertEqual(manifest['thresholds'],
                             {'d1-3B': 0.25, 'pplx-decider-flash-v1.2': 0.1})
            self.assertEqual(manifest['instructions_sha256'], ev.digest(le.INSTRUCTIONS))
            self.assertEqual(Path(out).read_text(), json.dumps(manifest, indent=2) + '\n')
            for row in manifest['cases']:
                self.assertTrue(row['recognized'])
                self.assertLessEqual(row['request_tokens'], le.REQUEST_BUDGET)

    def test_freeze_refuses_a_plan_over_the_request_cap(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                le.freeze(le.synthetic_cases(), ('a', 'b', 'c', 'd', 'e'),
                          Path(folder) / 'frozen.json')

    def test_freeze_refuses_an_oversize_request_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                le.freeze(le.synthetic_cases(), ('d1-3B',),
                          Path(folder) / 'frozen.json', budget=100)

    def test_run_writes_one_artifact_per_model(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = le.freeze(le.synthetic_cases(), ('d1-3B',),
                                 Path(folder) / 'frozen.json')
            artifact = le.run(manifest, le.synthetic_cases(),
                              le.args_for(manifest, 'd1-3B', None),
                              Path(folder) / 'run.json', scorer=scorer({1, 2}))
            self.assertEqual(artifact['threshold'], 0.25)
            self.assertEqual(artifact['requests'], 3)
            self.assertEqual(len(artifact['cases']), 3)
            self.assertGreater(artifact['request_tokens'], 0)
            self.assertEqual(json.loads((Path(folder) / 'run.json').read_text())['model'],
                             'd1-3B')

    def test_run_refuses_a_drifted_leaf(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = le.freeze(le.synthetic_cases(), ('d1-3B',),
                                 Path(folder) / 'frozen.json')
            cases = list(le.synthetic_cases())
            first = cases[0]
            cases[0] = le.Case(first.id, first.kind, first.title, first.context, first.call,
                               le._leaf('different\n', 'log-0001', 1),
                               first.evidence, first.provenance)
            with self.assertRaises(ValueError):
                le.run(manifest, cases, le.args_for(manifest, 'd1-3B', None),
                       Path(folder) / 'run.json', scorer=scorer(set()))

    def test_run_refuses_drifted_evidence_annotations(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = le.freeze(le.synthetic_cases(), ('d1-3B',),
                                 Path(folder) / 'frozen.json')
            cases = list(le.synthetic_cases())
            first = cases[0]
            evidence = (le.Evidence(first.evidence[0].line, 'not the frozen text', 'x'),)
            cases[0] = le.Case(first.id, first.kind, first.title, first.context, first.call,
                               first.leaf, evidence, first.provenance)
            with self.assertRaises(ValueError):
                le.run(manifest, cases, le.args_for(manifest, 'd1-3B', None),
                       Path(folder) / 'run.json', scorer=scorer(set()))

    def test_run_refuses_foreign_instructions(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = le.freeze(le.synthetic_cases(), ('d1-3B',),
                                 Path(folder) / 'frozen.json')
            manifest['instructions_sha256'] = '0' * 64
            with self.assertRaises(ValueError):
                le.run(manifest, le.synthetic_cases(), le.args_for(manifest, 'd1-3B', None),
                       Path(folder) / 'run.json', scorer=scorer(set()))

    def test_args_for_rejects_a_model_outside_the_frozen_set(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = le.freeze(le.synthetic_cases(), ('d1-3B',),
                                 Path(folder) / 'frozen.json')
            with self.assertRaises(ValueError):
                le.args_for(manifest, 'pplx-decider-flash-v1.2', None)


class CompareTest(unittest.TestCase):
    def runs(self, folder):
        manifest = le.freeze(le.synthetic_cases(), ('d1-3B', 'pplx-decider-flash-v1.2'),
                             Path(folder) / 'frozen.json')
        out = []
        for model in ('d1-3B', 'pplx-decider-flash-v1.2'):
            artifact = le.run(manifest, le.synthetic_cases(),
                              le.args_for(manifest, model, None),
                              Path(folder) / (model + '.json'), scorer=scorer({1, 2}),
                              frozen_sha256='frozen-sha')
            out.append(artifact)
        return out

    def test_compare_writes_an_authoritative_json_summary(self):
        with tempfile.TemporaryDirectory() as folder:
            runs = self.runs(folder)
            summary = le.compare(runs, Path(folder) / 'summary.json')
            self.assertEqual(summary['requests'], 6)
            self.assertEqual(summary['request_cap'], le.REQUEST_CAP)
            self.assertEqual(json.loads((Path(folder) / 'summary.json').read_text())
                             ['requests'], 6)
            self.assertEqual(len(summary['cases']), 6)
            self.assertEqual(set(summary['cases'][0]['arms']), set(le.ARMS))

    def test_compare_refuses_more_than_the_frozen_cap(self):
        with tempfile.TemporaryDirectory() as folder:
            runs = self.runs(folder)
            runs[0]['requests'] = le.REQUEST_CAP
            with self.assertRaises(ValueError):
                le.compare(runs, Path(folder) / 'summary.json')

    def test_compare_refuses_runs_from_different_manifests(self):
        with tempfile.TemporaryDirectory() as folder:
            runs = self.runs(folder)
            runs[1]['frozen_sha256'] = 'other'
            with self.assertRaises(ValueError):
                le.compare(runs, Path(folder) / 'summary.json')


def edit_args(**over):
    base = dict(model='d1-3B', model_path=None, backend='mlx', max_tokens=32000,
                timeout=120.0, prefix_cache_gb=None, max_input_tokens=0, noul_floor=None,
                illustrative=0.5, request_budget=32000, deadline_ms=0)
    base.update(over)
    return SimpleNamespace(**base)


DISCRIMINATING = {'progress-drop': 0.91, 'tail-only': 0.08,
                  'unrelated-helper-drop': 0.86, 'brace-cut': 0.14, 'whole-output': 0.03,
                  'reported-kept': 0.93, 'script-hits-only': 0.11}


def edit_scorer(scores=None):
    """A fake runtime with a fixed p_accept per edit id; it never sees the labels."""
    calls = []

    def score(a, payload):
        calls.append(payload)
        fixed = DISCRIMINATING if scores is None else scores
        return ({qid: fixed[qid] for qid in payload['questions']}, 7.0,
                {'input_tokens': 100, 'output_tokens': 0})

    score.calls = calls
    return score


class ControlEditTest(unittest.TestCase):
    def test_controls_cover_every_fixture_with_accept_and_reject(self):
        cases = le.control_cases()
        self.assertEqual([case.id for case, _ in cases],
                         ['synthetic-build-log', 'synthetic-host-config-review',
                          'synthetic-cpu-search'])
        for case, edits in cases:
            with self.subTest(case=case.id):
                labels = {edit.expected for edit in edits}
                self.assertEqual(labels, {'accept', 'reject'})
                self.assertEqual(len({edit.id for edit in edits}), len(edits))
                le.check_controls(case, decoded(case), edits)

    def test_corrected_cpu_rubric_requires_only_the_reported_values(self):
        case = le.synthetic_cases()[2]
        required = le.control_required(case)
        self.assertEqual([item.line for item in required], [2, 3])
        self.assertNotEqual([item.line for item in required],
                            [item.line for item in case.evidence])
        self.assertIn('Corrected', le.CONTROL_RUBRIC['synthetic-cpu-search'])

    def test_mislabelled_controls_are_refused(self):
        case = le.synthetic_cases()[0]
        result = decoded(case)
        bad_accept = (le.Edit('bad', ((12, 20),), 'accept', 'drops the failure episode'),)
        with self.assertRaises(ValueError):
            le.check_controls(case, result, bad_accept)
        bad_reject = (le.Edit('bad', ((2, 11),), 'reject', 'drops only progress'),)
        with self.assertRaises(ValueError):
            le.check_controls(case, result, bad_reject)

    def test_proposal_is_the_exact_render_of_its_ranges(self):
        for case, edits in le.control_cases():
            result = decoded(case)
            for edit in edits:
                keep, drop = le.kept_from_removed(len(result.lines), edit.removed)
                with self.subTest(case=case.id, edit=edit.id):
                    view = le.edit_view(result, edit)
                    rendered = ol.render(result, keep)
                    self.assertEqual(view['proposal_text'], rendered.text)
                    self.assertEqual([item['lines'] for item in view['omissions']],
                                     ['%d-%d' % (o.start + 1, o.end) if o.count > 1
                                      else str(o.start + 1) for o in rendered.omissions])
                    for omission in rendered.omissions:
                        self.assertIn(omission.marker, view['proposal_text'])
                    kept_numbers = [line.number for line in rendered.kept]
                    self.assertEqual(sorted(set(range(1, len(result.lines) + 1))
                                            - set(kept_numbers)), sorted(drop))
                    for line in rendered.kept:
                        self.assertEqual(line, result.lines[line.number - 1])
                    for omission in rendered.omissions:
                        removed = ol.omitted_text(result.raw, ol.PRODUCER,
                                                  result.source_sha256,
                                                  omission.start, omission.end)
                        self.assertEqual(removed,
                                         ''.join(line.text for line in
                                                 result.lines[omission.start:omission.end]))

    def test_state_carries_the_full_original_and_every_complete_proposal(self):
        for case, edits in le.control_cases():
            result = decoded(case)
            payload, views = le.edit_request(case, result, edits)
            state = payload['state']
            with self.subTest(case=case.id):
                self.assertEqual(state['recent_user_context'], case.context)
                self.assertEqual(state['tool_call'], case.call)
                blocks = state['candidate_tool_output']['blocks']
                self.assertEqual([block['text'] for block in blocks],
                                 [line.text for line in result.lines])
                self.assertEqual(state['source_sha256'], result.source_sha256)
                self.assertEqual([edit['edit'] for edit in state['candidate_edits']],
                                 [edit.id for edit in edits])
                self.assertEqual([edit['proposal_text'] for edit in state['candidate_edits']],
                                 [view['proposal_text'] for view in views])

    def test_each_question_names_one_view_and_alternatives_are_never_unioned(self):
        case, edits = le.control_cases()[1]
        payload, _ = le.edit_request(case, decoded(case), edits)
        self.assertEqual(set(payload['questions']), {edit.id for edit in edits})
        for edit in edits:
            instructions = payload['questions'][edit.id]['instructions']
            self.assertEqual(payload['questions'][edit.id]['type'], 'noul')
            self.assertIn('Candidate edit %s' % edit.id, instructions)
            self.assertIn('never combined', instructions)
        self.assertIn('never unioned', payload['state']['alternatives_rule'])

    def test_reviewer_labels_and_judgments_never_enter_the_request(self):
        for case, edits in le.control_cases():
            payload, _ = le.edit_request(case, decoded(case), edits)
            serialized = json.dumps(payload, ensure_ascii=False)
            with self.subTest(case=case.id):
                self.assertIsNone(re.search(r'\b(accept|reject)\w*\b', serialized))
                self.assertNotIn('expected', serialized)
                for edit in edits:
                    self.assertNotIn(edit.judgment, serialized)
                    self.assertNotIn('must_contain', serialized)
                for reasoning in le.CONTROL_RUBRIC.values():
                    self.assertNotIn(reasoning, serialized)

    def test_missing_answer_is_rejected_for_that_view_only(self):
        case, edits = le.control_cases()[0]

        def partial(a, payload):
            return {'progress-drop': 0.9}, 3.0, {}

        result = le.evaluate_edits(case, edits, edit_args(), partial)
        rows = {row['edit']: row for row in result['views']}
        self.assertTrue(rows['progress-drop']['accept'])
        self.assertEqual(rows['progress-drop']['p_accept'], 0.9)
        self.assertFalse(rows['tail-only']['accept'])
        self.assertIsNone(rows['tail-only']['p_accept'])
        self.assertEqual(rows['tail-only']['reason'], 'missing-answer')

    def test_oversize_sends_nothing_and_rejects_every_view(self):
        case, edits = le.control_cases()[0]
        fake = edit_scorer()
        result = le.evaluate_edits(case, edits, edit_args(request_budget=100), fake)
        self.assertEqual(fake.calls, [])
        self.assertIsNone(result['request'])
        self.assertEqual(result['abstain']['kind'], 'oversize')
        for row in result['views']:
            self.assertFalse(row['accept'])
            self.assertIsNone(row['p_accept'])
            self.assertEqual(row['reason'], 'oversize')

    def test_runtime_failure_rejects_every_view_and_records_it(self):
        case, edits = le.control_cases()[2]
        fake = failing()
        result = le.evaluate_edits(case, edits, edit_args(), fake)
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(result['request']['kind'], 'unavailable')
        for row in result['views']:
            self.assertFalse(row['accept'])
            self.assertEqual(row['reason'], 'unavailable')

    def test_discriminating_scores_separate_the_known_controls(self):
        for case, edits in le.control_cases():
            result = le.evaluate_edits(case, edits, edit_args(), edit_scorer())
            expected = {edit.id: edit.expected for edit in edits}
            with self.subTest(case=case.id):
                for row in result['views']:
                    self.assertEqual(row['accept'],
                                     expected[row['edit']] == 'accept')

    def test_known_unsafe_control_is_never_relabelled_safe(self):
        case, edits = le.control_cases()[1]
        cases_edits = le.control_cases()
        all_yes = {edit.id: 0.99 for _, edits in cases_edits for edit in edits}
        result = le.evaluate_edits(case, edits, edit_args(), edit_scorer(all_yes))
        rows = {row['edit']: row for row in result['views']}
        self.assertEqual(rows['whole-output']['expected'], 'reject')
        self.assertTrue(rows['whole-output']['accept'])
        self.assertEqual(rows['whole-output']['reason'], 'scored')
        with tempfile.TemporaryDirectory() as folder:
            manifest = le.freeze_edits(cases_edits, ('d1-3B',),
                                       Path(folder) / 'frozen.json')
            artifact = le.run_edits(manifest, cases_edits,
                                    le.args_for_edits(manifest, 'd1-3B', None),
                                    Path(folder) / 'run.json',
                                    scorer=edit_scorer(all_yes), frozen_sha256='frozen-sha')
            summary = le.compare_edits([artifact], Path(folder) / 'summary.json')
        for value in summary['separation'].values():
            within = value['within_fixture_concordance']
            self.assertEqual(within['concordant'], 0)
            self.assertEqual(within['discordant'], 0)
            self.assertGreater(within['ties'], 0)
            self.assertEqual(within['concordance'], 0.5)
            self.assertEqual(value['pooled']['auc'], 0.5)

    def test_accepted_alternatives_are_never_unioned(self):
        cases_edits = le.control_cases()
        with tempfile.TemporaryDirectory() as folder:
            manifest = le.freeze_edits(cases_edits, ('d1-3B',),
                                       Path(folder) / 'frozen.json')
            artifact = le.run_edits(manifest, cases_edits, le.args_for_edits(
                manifest, 'd1-3B', None), Path(folder) / 'run.json',
                scorer=edit_scorer({edit.id: 0.99 for _, edits in cases_edits
                                    for edit in edits}), frozen_sha256='frozen-sha')
            summary = le.compare_edits([artifact], Path(folder) / 'summary.json')
        frozen = {row['id']: [(edit['edit'], tuple(tuple(pair) for pair in
                                                   edit['removed_line_ranges']))
                              for edit in row['edits']] for row in manifest['cases']}
        for case in summary['cases']:
            recorded = [(view['edit'], tuple(tuple(pair) for pair in
                                             view['removed_line_ranges']))
                        for view in case['views']]
            self.assertEqual(recorded, frozen[case['id']])
            self.assertEqual(len(case['views']), len(frozen[case['id']]))
            self.assertTrue(all(view['accept'] for view in case['views']))
            for key in ('union', 'merged', 'combined'):
                self.assertNotIn(key, case)


class FreezeEditsTest(unittest.TestCase):
    def test_freeze_records_request_and_annotation_hashes(self):
        with tempfile.TemporaryDirectory() as folder:
            note = Path(folder) / 'ANNOTATION.md'
            note.write_text('# rubric\nCPU required: reported model and cores only.\n')
            out = Path(folder) / 'frozen.json'
            manifest = le.freeze_edits(le.control_cases(),
                                       ('d1-3B', 'pplx-decider-flash-v1.2'), out,
                                       annotation=note)
            self.assertEqual(manifest['version'], le.EDIT_VERSION)
            self.assertEqual(manifest['annotation_version'], le.EDIT_ANNOTATION_VERSION)
            self.assertEqual(manifest['annotation_sha256'],
                             ev.digest(note.read_text()))
            self.assertEqual(manifest['instructions_sha256'], ev.digest(le.EDIT_INSTRUCTIONS))
            self.assertEqual(manifest['alternatives_rule_sha256'],
                             ev.digest(le.ALTERNATIVES_RULE))
            self.assertEqual(manifest['requests_per_model'], 3)
            self.assertEqual(manifest['requests_total'], 6)
            self.assertEqual(manifest['illustrative_threshold'], 0.5)
            for row in manifest['cases']:
                self.assertEqual(len(row['request_sha256']), 64)
                self.assertEqual(len(row['leaf_sha256']), 64)
                self.assertEqual(len(row['context_sha256']), 64)
                self.assertLessEqual(row['request_tokens'], le.EDIT_BUDGET)
            self.assertEqual(Path(out).read_text(), json.dumps(manifest, indent=2) + '\n')
            le.verify_edits(manifest, le.control_cases())

    def test_freeze_refuses_a_plan_over_the_request_cap(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                le.freeze_edits(le.control_cases(), ('a', 'b', 'c', 'd'),
                                Path(folder) / 'frozen.json')

    def test_freeze_refuses_a_mislabelled_control(self):
        case = le.synthetic_cases()[0]
        bad = (case, (le.Edit('progress-drop', ((12, 20),), 'accept', 'wrong'),))
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                le.freeze_edits((bad,), ('d1-3B',), Path(folder) / 'frozen.json')

    def test_run_refuses_drifted_ranges(self):
        cases_edits = le.control_cases()
        with tempfile.TemporaryDirectory() as folder:
            manifest = le.freeze_edits(cases_edits, ('d1-3B',),
                                       Path(folder) / 'frozen.json')
            manifest['cases'][0]['edits'][0]['removed_line_ranges'] = [[1, 5]]
            with self.assertRaises(ValueError):
                le.run_edits(manifest, cases_edits, le.args_for_edits(
                    manifest, 'd1-3B', None), Path(folder) / 'run.json',
                    scorer=edit_scorer())

    def test_run_refuses_a_drifted_rubric(self):
        cases_edits = le.control_cases()
        with tempfile.TemporaryDirectory() as folder:
            manifest = le.freeze_edits(cases_edits, ('d1-3B',),
                                       Path(folder) / 'frozen.json')
            manifest['rubric'] = dict(manifest['rubric'])
            manifest['rubric']['synthetic-cpu-search'] = 'weaker rubric'
            with self.assertRaises(ValueError):
                le.run_edits(manifest, cases_edits, le.args_for_edits(
                    manifest, 'd1-3B', None), Path(folder) / 'run.json',
                    scorer=edit_scorer())


class CompareEditsTest(unittest.TestCase):
    def artifacts(self, folder, scores=None):
        cases_edits = le.control_cases()
        manifest = le.freeze_edits(cases_edits, ('d1-3B', 'pplx-decider-flash-v1.2'),
                                   Path(folder) / 'frozen.json')
        return [le.run_edits(manifest, cases_edits,
                             le.args_for_edits(manifest, model, None),
                             Path(folder) / (model + '.json'), scorer=edit_scorer(scores),
                             frozen_sha256='frozen-sha')
                for model in ('d1-3B', 'pplx-decider-flash-v1.2')]

    def test_compare_reports_raw_scores_and_separation(self):
        with tempfile.TemporaryDirectory() as folder:
            runs = self.artifacts(folder)
            summary = le.compare_edits(runs, Path(folder) / 'summary.json')
            self.assertEqual(summary['requests'], 6)
            self.assertEqual(summary['request_cap'], le.EDIT_CAP)
            for model, value in summary['separation'].items():
                with self.subTest(model=model):
                    within = value['within_fixture_concordance']
                    self.assertEqual(within['pairs'], 4)
                    self.assertEqual(within['concordant'], 4)
                    self.assertEqual(within['concordance'], 1.0)
                    self.assertEqual(within['separable_cases'], 3)
                    self.assertEqual(value['pooled']['pairs'], 12)
                    self.assertEqual(value['pooled']['auc'], 1.0)
                    self.assertTrue(value['pooled']['separable'])
                    self.assertTrue(value['coverage']['complete'])
            self.assertEqual(json.loads((Path(folder) / 'summary.json').read_text())
                             ['requests'], 6)

    def test_compare_reports_a_failure_ordering_honestly(self):
        with tempfile.TemporaryDirectory() as folder:
            runs = self.artifacts(folder, scores={edit_id: 0.5
                                                  for edit_id in DISCRIMINATING})
            summary = le.compare_edits(runs, Path(folder) / 'summary.json')
            for value in summary['separation'].values():
                within = value['within_fixture_concordance']
                self.assertEqual(within['concordant'], 0)
                self.assertEqual(within['discordant'], 0)
                self.assertEqual(within['concordance'], 0.5)
                self.assertEqual(value['pooled']['auc'], 0.5)
                self.assertEqual(value['pooled']['concordant'], 0)
                self.assertEqual(value['pooled']['discordant'], 0)
                self.assertFalse(value['pooled']['separable'])
                self.assertFalse(any(cell['separable']
                                     for cell in within['cases'].values()))

    def test_compare_refuses_more_than_the_frozen_cap(self):
        with tempfile.TemporaryDirectory() as folder:
            runs = self.artifacts(folder)
            runs[0]['requests'] = le.EDIT_CAP
            with self.assertRaises(ValueError):
                le.compare_edits(runs, Path(folder) / 'summary.json')

    def test_compare_refuses_runs_from_different_manifests(self):
        with tempfile.TemporaryDirectory() as folder:
            runs = self.artifacts(folder)
            runs[1]['frozen_sha256'] = 'other'
            with self.assertRaises(ValueError):
                le.compare_edits(runs, Path(folder) / 'summary.json')


# Full-precision scores from the reviewed joint-view run. The d1 scores have perfect
# within-fixture ordering but two across-fixture inversions.
D1_SCORES = {'progress-drop': 0.760, 'tail-only': 0.475,
             'unrelated-helper-drop': 0.428, 'brace-cut': 0.402,
             'whole-output': 0.194, 'reported-kept': 0.690,
             'script-hits-only': 0.496}
PPLX_SCORES = {'progress-drop': 0.9154, 'tail-only': 0.3651,
               'unrelated-helper-drop': 0.7069, 'brace-cut': 0.5974,
               'whole-output': 0.0431, 'reported-kept': 0.9841,
               'script-hits-only': 0.0523}


class SeparationTest(unittest.TestCase):
    def artifact(self, folder, score):
        cases_edits = le.control_cases()
        manifest = le.freeze_edits(cases_edits, ('d1-3B',),
                                   Path(folder) / 'frozen.json')
        return le.run_edits(manifest, cases_edits,
                            le.args_for_edits(manifest, 'd1-3B', None),
                            Path(folder) / 'run.json', scorer=score,
                            frozen_sha256='frozen-sha')

    def report(self, folder, artifact):
        return le.compare_edits([artifact], Path(folder) / 'summary.json')

    def test_within_fixture_ordering_is_not_a_pooled_metric(self):
        with tempfile.TemporaryDirectory() as folder:
            summary = self.report(folder, self.artifact(folder, edit_scorer(D1_SCORES)))
            value = summary['separation']['d1-3B']
            within = value['within_fixture_concordance']
            self.assertEqual((within['pairs'], within['concordant'], within['ties'],
                              within['discordant']), (4, 4, 0, 0))
            self.assertEqual(within['concordance'], 1.0)
            self.assertEqual(within['separable_cases'], 3)
            self.assertNotIn('auc', within)
            pooled = value['pooled']
            self.assertEqual((pooled['pairs'], pooled['concordant'], pooled['ties'],
                              pooled['discordant']), (12, 10, 0, 2))
            self.assertAlmostEqual(pooled['auc'], 10.0 / 12.0)
            self.assertEqual(pooled['min_accept'], 0.428)
            self.assertEqual(pooled['max_reject'], 0.496)
            self.assertAlmostEqual(pooled['margin'], 0.428 - 0.496)
            self.assertFalse(pooled['separable'])
            self.assertEqual(value['coverage'],
                             {'views': 7, 'answered': 7, 'missing': 0, 'complete': True,
                              'accept': {'views': 3, 'answered': 3},
                              'reject': {'views': 4, 'answered': 4}})
            self.assertEqual(json.loads((Path(folder) / 'summary.json').read_text())
                             ['separation']['d1-3B']['pooled']['auc'],
                             pooled['auc'])

    def test_pooled_auc_of_one_is_still_only_the_same_development_controls(self):
        with tempfile.TemporaryDirectory() as folder:
            summary = self.report(folder, self.artifact(folder, edit_scorer(PPLX_SCORES)))
            value = summary['separation']['d1-3B']
            self.assertEqual(value['within_fixture_concordance']['concordance'], 1.0)
            self.assertEqual(value['pooled']['pairs'], 12)
            self.assertEqual(value['pooled']['concordant'], 12)
            self.assertEqual(value['pooled']['auc'], 1.0)
            self.assertTrue(value['pooled']['separable'])
            self.assertEqual(value['coverage']['views'], 7)
            self.assertTrue(value['coverage']['complete'])

    def test_missing_answers_are_counted_and_cannot_look_like_full_coverage(self):
        def partial(a, payload):
            return ({qid: DISCRIMINATING[qid] for qid in payload['questions']
                     if qid != 'unrelated-helper-drop'}, 7.0,
                    {'input_tokens': 100, 'output_tokens': 0})

        with tempfile.TemporaryDirectory() as folder:
            artifact = self.artifact(folder, partial)
            summary = self.report(folder, artifact)
            value = summary['separation']['d1-3B']
            self.assertEqual(value['coverage'],
                             {'views': 7, 'answered': 6, 'missing': 1, 'complete': False,
                              'accept': {'views': 3, 'answered': 2},
                              'reject': {'views': 4, 'answered': 4}})
            self.assertEqual(value['within_fixture_concordance']['pairs'], 2)
            self.assertEqual(value['within_fixture_concordance']['concordance'], 1.0)
            self.assertEqual(value['within_fixture_concordance']['separable_cases'], 2)
            self.assertEqual(value['pooled']['pairs'], 8)
            self.assertEqual(value['pooled']['auc'], 1.0)
            rows = {row['edit']: row for case in artifact['cases']
                    for row in case['views']}
            self.assertFalse(rows['unrelated-helper-drop']['accept'])
            self.assertEqual(rows['unrelated-helper-drop']['reason'], 'missing-answer')



class ReviewRegressionTests(unittest.TestCase):
    def test_context_and_group_drift_refuse_before_scoring(self):
        from dataclasses import replace
        from unittest.mock import Mock
        cases = le.synthetic_cases()
        with tempfile.TemporaryDirectory() as tmp:
            manifest = le.freeze(cases, ['d1-3B'], Path(tmp) / 'freeze.json')
            a = le.args_for(manifest, 'd1-3B', None)
            for changed in (replace(cases[0], context='different task'),
                            replace(cases[0], call={'name': 'different'})):
                score = Mock()
                with self.assertRaisesRegex(ValueError, 'context or call drifted'):
                    le.run(manifest, (changed,) + cases[1:], a, Path(tmp) / 'out', scorer=score)
                score.assert_not_called()
            manifest['cases'][0]['group_questions'] = [999]
            with self.assertRaisesRegex(ValueError, 'grouping drifted'):
                le.verify(manifest, cases)

    def test_dispatch_cap_is_enforced_before_extra_call(self):
        from unittest.mock import Mock
        manifest = {'models': ['d1-3B'], 'request_budget': 32000,
                    'cases': [{'groups': 1}], 'requests_per_model': 1, 'request_cap': 1}
        scorer = Mock(return_value=({}, 0, {}))
        score = le.bounded_scorer(manifest, args(), scorer)
        score(args(), {})
        with self.assertRaisesRegex(ValueError, 'cap reached'):
            score(args(), {})
        self.assertEqual(scorer.call_count, 1)

    def test_duplicate_models_are_not_silently_overwritten(self):
        row = {'model': 'd1-3B', 'frozen_sha256': 'same', 'requests': 1, 'request_cap': 12}
        with self.assertRaisesRegex(ValueError, 'duplicate model'):
            le._compare([row, dict(row)])

    def test_model_load_failure_writes_conservative_artifact(self):
        from unittest.mock import patch
        cases = le.control_cases()
        with tempfile.TemporaryDirectory() as tmp:
            manifest = le.freeze_edits(cases, ['d1-3B'], Path(tmp) / 'freeze.json')
            a = le.args_for_edits(manifest, 'd1-3B', '/missing/model')
            out = Path(tmp) / 'result.json'
            with patch.object(ev, 'load_mlx', side_effect=FileNotFoundError('weights missing')):
                le.run_edits(manifest, cases, a, out)
            result = json.loads(out.read_text())
            self.assertEqual(result['requests'], 3)
            for case in result['cases']:
                for view in case['views']:
                    self.assertIsNone(view['p_accept'])
                    self.assertFalse(view['accept'])

    def test_cli_does_not_advertise_ineffective_timeout(self):
        import contextlib
        import io
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit):
            le.main(['run-edits', '--help'])
        self.assertNotIn('--timeout', output.getvalue())


if __name__ == '__main__':
    unittest.main()
