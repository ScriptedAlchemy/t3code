"""Structural and requested-source protection, and the protection identity gate.

All fixtures are synthetic. Nothing here reads a transcript, an identity map or a model.
"""
import json
import tempfile
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


def write_case(folder, users, call, output, name='rollout.jsonl'):
    path = Path(folder) / name
    lines = []
    for message in users:
        lines.append({'type': 'response_item',
                      'payload': {'type': 'message', 'role': 'user',
                                  'content': [{'type': 'input_text', 'text': message}]}})
    lines.append({'type': 'response_item', 'payload': call})
    lines.append({'type': 'response_item',
                  'payload': {'type': 'function_call_output', 'call_id': call['call_id'],
                              'status': 'completed', 'output': output}})
    path.write_text('\n'.join(json.dumps(line) for line in lines) + '\n')
    return {'id': 'case-0001', 'source': str(path), 'line': len(users) + 2,
            'split': 'development', 'sha256': e.digest(e.text(output)),
            'context': 'ignored manifest context', 'call': call,
            'original_tokens': e.tokens(e.text(output))}


def call(name, arguments, call_id='call-1'):
    return {'type': 'function_call', 'call_id': call_id, 'name': name,
            'arguments': json.dumps(arguments)}


def zero(a, payload):
    return {q: 0.0 for q in payload['questions']}, 1.0, {}


def plain(lines=200):
    return ''.join(f'    row_{i} = select("key_{i}", filter_{i}, limit_{i})\n'
                   for i in range(lines))


def long_json(lines=200):
    rows = ''.join(f'  "row_{i}": {{"id": {i}, "state": "on", "note": "value {i}"}},\n'
                   for i in range(lines))
    return '{\n' + rows + '  "done": true\n}\n'


class StructureSpanTests(unittest.TestCase):
    def test_complete_json_after_malformed_start_is_still_protected(self):
        raw = 'header\ndata: {"bad":\nordinary text\n' + '{"good": [1, 2]}'
        start = raw.index('{"good"')
        self.assertIn((start, len(raw)), e.json_container_spans(raw))

    def test_excessive_nesting_retains_the_entire_leaf(self):
        nested = '[' * 10000 + '0' + ']' * 10000
        for raw in (nested, 'header\n' + nested,
                    '{"output":"stdout","metadata":' + nested + '}'):
            with self.subTest(prefix=raw[:20]):
                plan = e.plan_blocks(raw)
                self.assertEqual(set(e.structure_keep(plan)), {p['block'] for p in plan})
                with tempfile.TemporaryDirectory() as tmp:
                    case = write_case(tmp, ['Inspect the result.'],
                                      call('exec', {'cmd': 'build'}), raw)
                    with patch.object(e, 'score_request', side_effect=zero) as scorer:
                        result = e.score_case(args(), case)
                    scorer.assert_not_called()
                    self.assertEqual(result['after_sha256'], result['before_sha256'])

    def test_long_trace_after_json_does_not_scan_growing_slices(self):
        class NoSlices(str):
            def __getitem__(self, key):
                if isinstance(key, slice):
                    raise AssertionError('scanner copied a text slice')
                return super().__getitem__(key)
        raw = NoSlices('{}\n' + 'ordinary trace text\n' * 40000)
        self.assertEqual(e.json_container_spans(raw), [(0, 2)])

    def test_scalars_are_never_containers(self):
        for raw in ('42', '"a string"', 'true', 'null', '-1.5e3'):
            self.assertEqual(e.json_container_spans(raw), [], raw)

    def test_prose_and_code_braces_are_not_containers(self):
        samples = [
            'fn main() {\n    let x = 1;\n}\n',
            'if (ready) {\n  run();\n}\n',
            'const f = (x) => { return x; };\n',
            'the set {a, b} is not json\n',
            'exit code {0}\n',
        ]
        for raw in samples:
            self.assertEqual(e.json_container_spans(raw), [], raw)
            self.assertEqual(e.structure_keep(e.plan_blocks(raw)), {}, raw)

    def test_object_and_array_offsets(self):
        raw = '{"a": 1}'
        self.assertEqual(e.json_container_spans(raw), [(0, len(raw))])
        raw = '[1, 2, 3]'
        self.assertEqual(e.json_container_spans(raw), [(0, len(raw))])
        raw = '{}'
        self.assertEqual(e.json_container_spans(raw), [(0, 2)])

    def test_multiple_values_advance_past_successful_outer_values(self):
        self.assertEqual(e.json_container_spans('{"a":1}\n{"b":2}'), [(0, 7), (8, 15)])
        self.assertEqual(e.json_container_spans('[1]\n[2]\n[3]'),
                         [(0, 3), (4, 7), (8, 11)])
        self.assertEqual(e.json_container_spans('{"a":1} {"b":2}'), [(0, 7), (8, 15)])
        self.assertEqual(e.json_container_spans('{} [] {"a": []}'),
                         [(0, 2), (3, 5), (6, 15)])

    def test_nested_container_is_covered_by_the_outer_span(self):
        raw = '{"a": [1, {"b": 2}]}'
        self.assertEqual(e.json_container_spans(raw), [(0, len(raw))])

    def test_leading_and_trailing_prose_are_outside_the_span(self):
        raw = 'prefix = {"x": 1} then done'
        self.assertEqual(e.json_container_spans(raw), [(9, 17)])
        self.assertEqual(raw[9:17], '{"x": 1}')

    def test_crlf_offsets(self):
        raw = '{"a": 1}\r\n{"b": 2}\r\n'
        self.assertEqual(e.json_container_spans(raw), [(0, 8), (10, 18)])
        self.assertEqual(raw[10:18], '{"b": 2}')

    def test_unicode_character_offsets(self):
        raw = '首 = {"label": "值", "emoji": "🎯"} tail'
        spans = e.json_container_spans(raw)
        self.assertEqual(len(spans), 1)
        start, end = spans[0]
        self.assertTrue(raw[start:].startswith('{'))
        self.assertEqual(json.loads(raw[start:end]), {'label': '值', 'emoji': '🎯'})
        self.assertEqual(raw[end:], ' tail')

    def test_escaped_newlines_inside_a_value(self):
        raw = '{"body": "a\\nb", "code": 0}'
        self.assertEqual(e.json_container_spans(raw), [(0, len(raw))])
        self.assertEqual(json.loads(raw)['body'], 'a\nb')

    def test_json_shaped_truncation_is_unverified_to_end_of_leaf(self):
        for raw in ('{"a": 1,\n  "b": [2, 3', '[1, 2', '[{"a": 1}, {"b"', '{"a": '):
            self.assertEqual(e.json_container_spans(raw), [], raw)
            keep = e.structure_keep(e.plan_blocks(raw))
            self.assertEqual(set(keep), {0}, raw)
            self.assertEqual(keep[0]['reason'], 'json_container_unverified', raw)
            self.assertEqual(keep[0]['spans'], [[0, len(raw)]], raw)

    def test_prose_brackets_and_type_slices_are_not_truncated_containers(self):
        for raw in ('[see the notes](https://example.com)\n', '[u8; 4]\n',
                    'let buf: [u8; 4]\n', '[a, b, c]\n'):
            self.assertEqual(e.structure_keep(e.plan_blocks(raw)), {}, raw)

    def test_inline_argument_brackets_are_not_containers(self):
        trace = ''.join(f'915  execve("/work/bin", ["/work/bin", "arg{i}"], 0x7f) = 0\n'
                        for i in range(120))
        plan = e.plan_blocks(trace)
        self.assertGreater(len(plan), 2)
        self.assertEqual(e.structure_keep(plan), {})
        self.assertEqual(e.json_container_spans(trace), [])

    def test_space_separated_values_keep_every_block_they_touch(self):
        raw = '{"a": 1} {"b": 2}'
        plan = e.plan_blocks(raw)
        keep = e.structure_keep(plan)
        self.assertEqual(set(keep), {p['block'] for p in plan})

    def test_mid_text_container_start_retains_only_its_block(self):
        raw = plain(60) + 'data: {"a": 1, "b": [2, 3\n' + plain(60)
        plan = e.plan_blocks(raw)
        self.assertGreater(len(plan), 2)
        keep = e.structure_keep(plan)
        self.assertEqual(len(keep), 1, keep)
        block, hit = next(iter(keep.items()))
        self.assertEqual(hit['reason'], 'json_container_unverified')
        (start, end), = hit['spans']
        self.assertGreater(start, 0)
        # Bounded by the block that carries the questionable start, never the whole tail.
        self.assertEqual(end, len(plan[block]['part']))
        self.assertLess(block + 1, len(plan))

    def test_truncated_non_json_brace_is_not_unverified(self):
        raw = 'fn main() {\n  if (x) {'
        self.assertEqual(e.structure_keep(e.plan_blocks(raw)), {})


class StructureBlockMappingTests(unittest.TestCase):
    def test_every_overlapping_block_of_one_leaf_is_kept(self):
        raw = long_json()
        plan = e.plan_blocks(raw)
        self.assertGreater(len(plan), 2)
        keep = e.structure_keep(plan)
        self.assertEqual(set(keep), {p['block'] for p in plan})
        self.assertTrue(all(v['reason'] == 'json_container' for v in keep.values()))

    def test_span_maps_to_all_and_only_overlapping_blocks(self):
        rows = ''.join(f'  {i},\n' for i in range(299)) + '  299\n'
        array = '[\n' + rows + ']\n'
        raw = array + plain(200)
        plan = e.plan_blocks(raw)
        self.assertGreater(len(plan), 2)
        keep = e.structure_keep(plan)
        self.assertTrue(keep)
        bounds = []
        position = 0
        for p in plan:
            bounds.append((p['block'], position, position + len(p['part'])))
            position += len(p['part'])
        # Reconstruct absolute coverage from the block-local spans.
        covered = sorted((begin + start, begin + end)
                         for block, begin, finish in bounds if block in keep
                         for start, end in keep[block]['spans'])
        self.assertEqual(covered[0][0], 0)
        self.assertEqual(max(end for _, end in covered), len(array) - 1)
        expected = {b for b, begin, finish in bounds
                    if begin < len(array) - 1 and 0 < finish}
        self.assertEqual(set(keep), expected)
        # The trailing plain lines are outside the container and stay droppable.
        self.assertLess(len(keep), len(plan))

    def test_json_in_one_leaf_never_protects_another_leaf(self):
        plan = e.plan_blocks([{'type': 'input_text', 'text': plain(60)},
                              {'type': 'input_text', 'text': '{"a": 1}'}])
        keep = e.structure_keep(plan)
        first = {p['block'] for p in plan if p['path'] == [0, 'text']}
        self.assertEqual(set(keep), {p['block'] for p in plan if p['path'] == [1, 'text']})
        self.assertFalse(first & set(keep))


class RequestedSourceTests(unittest.TestCase):
    def test_read_tool_with_named_path_is_selected(self):
        meta = {'ok': True,
                'call_rendered': {'name': 'read', 'command': '{"path": "src/serde.rs"}'},
                'instructions': [{'text': 'Review src/serde.rs for the wire format.',
                                  'line': 1}]}
        self.assertEqual(e.source_selection(meta),
                         [{'path': 'src/serde.rs', 'call': 'read', 'instruction_line': 1}])

    def test_basename_in_instruction_is_enough_when_exact_path_is_not_written(self):
        for instruction, selected in (
            ('Please inspect serde.rs and report.', True),
            ('Please inspect serde.rs.', True),
            ('Please inspect my_serde.rs.', False),
            ('Please inspect serde.rs.bak.', False),
        ):
            meta = {'ok': True,
                    'call_rendered': {'name': 'read', 'command': '{"file_path": "a/b/serde.rs"}'},
                    'instructions': [{'text': instruction, 'line': 2}]}
            self.assertEqual(e.source_selection(meta) is not None, selected, instruction)

    def test_reader_shell_command_with_one_operand_is_selected(self):
        for command in ('cat src/serde.rs', 'head -n 5 src/serde.rs',
                        "sed -n '20,80p' src/serde.rs",
                        'cat src/serde.rs src/other.rs',
                        "cd /work/app && sed -n '1,120p' src/serde.rs; cat src/other.rs"):
            with self.subTest(command=command):
                meta = {'ok': True, 'call_rendered': {'name': 'exec', 'command': command},
                        'instructions': [{'text': 'Read src/serde.rs.', 'line': 1}]}
                self.assertEqual(len(e.source_selection(meta)), 1)

    def test_literal_harness_calls_preserve_requested_source(self):
        commands = [
            ('exec_command', json.dumps({'cmd': "sed -n '1,120p' src/serde.rs",
                                         'workdir': '/work/app'})),
            ('functions.exec', 'text(await tools.exec_command({cmd: "cat src/serde.rs", '
                              'workdir: "/work/app", max_output_tokens: 8000})); '
                              'text(await tools.exec_command({cmd: "cat src/other.rs"}));'),
            ('exec', "text(await tools.exec_command({cmd: 'cat src/serde.rs'}));"),
        ]
        for name, command in commands:
            with self.subTest(name=name, command=command):
                meta = {'ok': True, 'call_rendered': {'name': name, 'command': command},
                        'instructions': [{'text': 'Review src/serde.rs.', 'line': 1}]}
                selected = e.source_selection(meta)
                self.assertEqual(len(selected), 1)
                self.assertTrue(selected[0]['path'].endswith('src/serde.rs'))
                self.assertEqual(selected[0]['instruction_line'], 1)

    def test_shell_composition_abstains(self):
        for command in ('cat a.rs | head -20', 'cat a.rs > out', 'cat a.rs && rm a.rs',
                        'cat $(find . -name a.rs)', 'cat `ls`',
                        'rg pattern a.rs', 'cat *.rs', 'cat $FILE',
                        'sed -i s/a/b/ a.rs', 'cat a.rs; exit', 'cat a.rs; # ignored',
                        'cat # a.rs'):
            meta = {'ok': True, 'call_rendered': {'name': 'exec', 'command': command},
                    'instructions': [{'text': 'Read a.rs.', 'line': 1}]}
            self.assertIsNone(e.source_selection(meta), command)

    def test_unknown_tool_and_json_arguments_abstain(self):
        calls = [
            ('exec', '{"path": "a.rs"}'),
            ('unknown_tool', 'cat a.rs'),
            ('exec', 'text("tools.exec_command({cmd: \'cat a.rs\'})");'),
            ('exec', 'if (false) { text(await tools.exec_command({cmd: "cat a.rs"})); }'),
            ('exec', 'text(await tools.exec_command({cmd: command}));'),
            ('exec', 'text(await tools.exec_command({cmd: `cat ${file}`}));'),
            ('exec', 'text(await tools.exec_command({cmd: "cat a.rs", cmd: "cat b.rs"}));'),
            ('exec_command', '{"cmd": "cat a.rs", "cmd": "cat b.rs"}'),
            ('exec_command', '{"cmd": "cat a.rs", "shell": "python"}'),
            ('exec', 'text(await tools.exec_command({cmd: "cat a.rs", shell: "python"}));'),
            ('exec', 'text(await tools.exec_command({cmd: "cat a.rs"})); mutate();'),
            ('read', '{"path": "a.rs", "path": "b.rs"}'),
        ]
        for name, command in calls:
            with self.subTest(name=name, command=command):
                meta = {'ok': True, 'call_rendered': {'name': name, 'command': command},
                        'instructions': [{'text': 'Read a.rs.', 'line': 1}]}
                self.assertIsNone(e.source_selection(meta))

    def test_unnamed_path_is_not_requested(self):
        meta = {'ok': True, 'call_rendered': {'name': 'read', 'command': '{"path": "a.rs"}'},
                'instructions': [{'text': 'Fix the parser bug.', 'line': 1}]}
        self.assertIsNone(e.source_selection(meta))

    def test_requested_source_keeps_the_whole_result_without_inventing_scores(self):
        body = plain(30) + long_json(30)
        seen = []

        def capture(a, payload):
            seen.append(payload)
            return {q: 0.0 for q in payload['questions']}, 1.0, {}

        calls = [
            call('read', {'path': 'src/serde.rs'}),
            call('exec_command', {'cmd': "sed -n '1,120p' src/serde.rs; cat src/other.rs",
                                  'workdir': '/work/app'}),
            {'type': 'custom_tool_call', 'call_id': 'call-1', 'name': 'exec',
             'input': 'text(await tools.exec_command({cmd: "cat src/serde.rs"})); '
                      'text(await tools.exec_command({cmd: "cat src/other.rs"}));'},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            for index, origin in enumerate(calls):
                with self.subTest(origin=origin):
                    case = write_case(tmp, ['Please review src/serde.rs now.'], origin, body,
                                      name=f'rollout-{index}.jsonl')
                    with patch.object(e, 'score_request', capture):
                        result = e.score_case(args(), case)
                    totals = e.build_report(args(), [result], {})['totals']
                    self.assertEqual(seen, [])
                    self.assertEqual(result['after'], result['before'])
                    self.assertGreater(totals['requested_source_blocks'], 0)
                    self.assertEqual(totals['asked_questions'], 0)
                    self.assertTrue(all(d['hard_source'] == 'source'
                                        for d in result['decisions'] if d['hard_keep']))
                    for d in result['decisions']:
                        if d['protected']:
                            continue
                        self.assertIsNone(d['p_keep'])
                        self.assertIsNone(d['proposed'])
                        self.assertEqual(d['effective'], 'keep')


class PolicyIdentityTests(unittest.TestCase):
    def _result(self, tmp, body=None):
        case = write_case(tmp, ['Goal: fix the parser'], call('read', {'path': 'x.py'}),
                          body or (plain(40) + '{"a": 1, "b": 2}\n' + plain(40)))
        with patch.object(e, 'score_request', zero):
            result = e.score_case(args(), case)
        return case, result

    def test_current_result_rethresholds_and_keeps_structure(self):
        with tempfile.TemporaryDirectory() as tmp:
            case, result = self._result(tmp)
            structure = {d['block'] for d in result['decisions']
                         if d['hard_source'] == 'structure'}
            self.assertTrue(structure)
            outcome = e.derive_case(result, 0.99, e.source_payload(case)['output'], case=case)
        self.assertTrue(outcome['protection_current'])
        for block in structure:
            self.assertEqual(outcome['effective'][block], 'keep')

    def test_missing_protection_identity_keeps_everything(self):
        with tempfile.TemporaryDirectory() as tmp:
            case, result = self._result(tmp)
            stale = json.loads(json.dumps(result))
            stale.pop('protection_version')
            outcome = e.derive_case(stale, 0.0, e.source_payload(case)['output'], case=case)
            cases_path = Path(tmp) / 'cases.json'
            cases_path.write_text(json.dumps({'cases': [case]}))
            result_path = Path(tmp) / 'stale.json'
            result_path.write_text(json.dumps(e.build_report(args(), [stale], {})))
            out = Path(tmp) / 'sweep.json'
            e.sweep(SimpleNamespace(result=str(result_path), cases=str(cases_path),
                                    thresholds='0.0,0.5', out=str(out)))
            swept = json.loads(out.read_text())
        self.assertFalse(outcome['protection_current'])
        self.assertIsNone(outcome['stale_protection'])
        self.assertTrue(outcome['abstain_all'])
        self.assertEqual(set(outcome['effective'].values()), {'keep'})
        self.assertFalse(swept['protection_current'])
        for row in swept['thresholds']:
            self.assertEqual(row['dropped_blocks'], 0)
            self.assertEqual(row['saved_fraction'], 0.0)

    def test_different_protection_identity_is_reported_and_not_adopted(self):
        with tempfile.TemporaryDirectory() as tmp:
            case, result = self._result(tmp)
            stale = json.loads(json.dumps(result))
            stale['protection_version'] = 'structure+evidence+source-v0'
            outcome = e.derive_case(stale, 0.0, e.source_payload(case)['output'], case=case)
        self.assertFalse(outcome['protection_current'])
        self.assertEqual(outcome['stale_protection'], 'structure+evidence+source-v0')
        self.assertEqual(set(outcome['effective'].values()), {'keep'})
        # No protection rule is adopted for a result measured under another policy.
        self.assertEqual(outcome['hard_keep'], {})
        self.assertTrue(outcome['abstain_all'])


class ProtectionAccountingTests(unittest.TestCase):
    def _run(self, tmp, body, call_payload=None, users=None):
        case = write_case(tmp, users or ['Goal: fix the parser'],
                          call_payload or call('read', {'path': 'x.py'}), body)
        seen = []

        def capture(a, payload):
            seen.append(payload)
            return {q: 0.0 for q in payload['questions']}, 1.0, {}

        with patch.object(e, 'score_request', capture):
            result = e.score_case(args(), case)
        return result, seen

    def test_hard_kept_blocks_never_reach_the_scorer(self):
        body = plain(40) + long_json(40) + plain(40)
        with tempfile.TemporaryDirectory() as tmp:
            result, seen = self._run(tmp, body)
        hard = {d['block'] for d in result['decisions'] if d['hard_keep']}
        self.assertTrue(hard)
        asked = {int(q[1:]) for payload in seen for q in payload['questions']}
        self.assertFalse(hard & asked)
        self.assertEqual(asked,
                         {d['block'] for d in result['decisions']
                          if not d['protected'] and not d['hard_keep']})
        for d in result['decisions']:
            if d['hard_keep']:
                self.assertIsNone(d['p_keep'])
                self.assertEqual(d['usage'], {})

    def test_totals_partition_and_question_accounting(self):
        body = plain(40) + long_json(40) + plain(40)
        with tempfile.TemporaryDirectory() as tmp:
            result, seen = self._run(tmp, body)
        report = e.build_report(args(), [result], {})
        totals = report['totals']
        self.assertEqual(totals['blocks'],
                         totals['protected_blocks'] + totals['hard_keep_blocks']
                         + totals['context_abstained_blocks'] + totals['eligible_blocks'])
        self.assertEqual(totals['asked_questions'],
                         sum(len(p['questions']) for p in seen))
        self.assertLessEqual(totals['asked_questions'], totals['eligible_blocks'])
        self.assertEqual(totals['unasked_eligible_questions'],
                         totals['eligible_blocks'] - totals['asked_questions'])
        self.assertEqual(totals['structure_protected_blocks'],
                         sum(1 for d in result['decisions'] if d['hard_source'] == 'structure'))
        self.assertGreater(totals['structure_protected_tokens'], 0)
        self.assertGreater(totals['eligible_tokens'], 0)
        self.assertEqual(totals['actual_calls'], totals['completed_requests'])
        self.assertGreater(totals['protected_share'], 0)
        self.assertEqual(report['protection_version'], e.PROTECTION_VERSION)

    def test_zero_candidates_sends_nothing_and_keeps_original(self):
        body = long_json(120)
        with tempfile.TemporaryDirectory() as tmp:
            result, seen = self._run(tmp, body)
        self.assertEqual(seen, [])
        self.assertEqual(result['requests'], 0)
        self.assertEqual(result['after'], result['before'])
        self.assertEqual(result['statuses'], {})
        self.assertTrue(all(d['effective'] == 'keep' for d in result['decisions']))
        self.assertTrue(all(d['proposed'] in (None, 'keep') for d in result['decisions']))


if __name__ == '__main__':
    unittest.main()
