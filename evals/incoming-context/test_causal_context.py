"""Tests for causal_context. Synthetic fixtures only; no transcript text is copied."""

import hashlib
import json
import unittest

import causal_context as cc


def record(payload, line=None, **extra):
    item = {'type': 'response_item', 'payload': payload}
    if line is not None:
        item['line'] = line
    item.update(extra)
    return item


def message(role, text, line=None):
    return record({'type': 'message', 'role': role,
                   'content': [{'type': 'text', 'text': text}]}, line=line)


def content_message(role, content, line=None):
    return record({'type': 'message', 'role': role, 'content': content}, line=line)


def call(call_id, name, body, field='input', line=None):
    payload = {'type': 'custom_tool_call' if field == 'input' else 'function_call',
               'call_id': call_id, 'name': name, field: body}
    return record(payload, line=line)


def output(call_id, text, line=None):
    return record({'type': 'custom_tool_call_output', 'call_id': call_id,
                   'output': [{'type': 'text', 'text': text}]}, line=line)


def running(cell_id, line=None, call_id='c-exec'):
    return output(call_id, f'Script running with cell ID {cell_id}\nWall time 9.8 seconds\n', line=line)


def finished(session_id=None, line=None, call_id='c-exec'):
    body = ('{"chunk_id":"ab12cd","wall_time_seconds":0.2,"%s":%s,'
            '"original_token_count":3,"output":"ok"}')
    session = ('"session_id":' + str(session_id)) if session_id is not None else '"exit_code":0'
    return output(call_id, 'Script completed\nWall time 0.2 seconds\nOutput:\n\n'
                           + body % (session.split(':')[0].strip('"'), session.split(':', 1)[1]),
                  line=line)


def compacted(history, metadata, line=None):
    return {'type': 'compacted', 'payload': {'replacement_history': history,
                                             'replacement_history_metadata': metadata},
            'line': line}


def verified(text, order=1, line=None, content=None):
    """A compacted record whose single retained user turn carries provenance."""
    item = {'type': 'message', 'role': 'user',
            'content': content if content is not None else [{'type': 'text', 'text': text}]}
    return compacted([item], [{'client_authored': True, 'retained_source': 'window-1',
                               'user_input_order': order}], line=line)


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def texts(instructions):
    return tuple(item.text for item in instructions)


class GoalTests(unittest.TestCase):
    def test_envelope_only_is_missing(self):
        records = [
            message('user', '# AGENTS.md instructions for /repo\n\nFollow the repository rules.', line=5),
            message('developer', 'Please delete the pruning code.', line=6),
            call('c1', 'exec', 'print(1)', line=7),
        ]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.goal.status, cc.MISSING)
        self.assertEqual(ctx.goal.reason, 'no_human_instruction')
        self.assertIsNone(ctx.goal.instruction)
        self.assertEqual(ctx.origin.status, cc.AVAILABLE)
        reasons = {e.reason for e in ctx.exclusions}
        self.assertIn('harness_envelope', reasons)
        self.assertIn('developer_role', reasons)

    def test_agents_marker_without_path_is_harness_envelope(self):
        records = [
            message('user', '# AGENTS.md instructions\n\nFollow the repository rules.', line=3),
            message('user', 'Remove the stale cache path.', line=4),
            call('c1', 'exec', 'ls'),
        ]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.goal.status, cc.AVAILABLE)
        self.assertEqual(ctx.goal.instruction.text, 'Remove the stale cache path.')
        self.assertEqual([e.reason for e in ctx.exclusions], ['harness_envelope'])

    def test_genuine_user_goal_exact_span(self):
        text = 'Remove the pruning code from evaluate.py'
        records = [message('user', text, line=12), call('c1', 'exec', 'ls', line=13)]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.goal.status, cc.AVAILABLE)
        instruction = ctx.goal.instruction
        self.assertEqual(instruction.provenance, cc.HUMAN)
        self.assertEqual(instruction.text, text)
        self.assertEqual(instruction.span.index, 0)
        self.assertEqual(instruction.span.field, 'payload.content[0].text')
        self.assertEqual((instruction.span.start, instruction.span.end), (0, len(text)))
        self.assertEqual(instruction.span.sha256, digest(text))
        self.assertEqual(instruction.span.line, 12)
        self.assertFalse(instruction.span.derived)
        self.assertEqual(instruction.span.sources, ())

    def test_ordered_user_turns_select_the_latest(self):
        records = [
            message('user', 'First request.'),
            message('user', 'Actually, the second request.'),
            call('c1', 'exec', 'ls'),
        ]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.goal.instruction.text, 'Actually, the second request.')
        self.assertEqual(texts(ctx.goal.instructions), ('First request.', 'Actually, the second request.'))

    def test_opaque_instruction_stays_missing(self):
        records = [
            record({'type': 'message', 'role': 'user',
                    'content': [{'type': 'encrypted_content', 'encrypted_content': 'AAAA'}]}),
            call('c1', 'exec', 'ls'),
        ]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.goal.status, cc.MISSING)
        self.assertEqual(ctx.goal.reason, 'opaque_instruction')
        self.assertIsNone(ctx.goal.instruction)

    def test_unknown_wrapper_abstains(self):
        records = [
            message('user', '<mystery_wrapper>Ship it</mystery_wrapper>'),
            message('user', '<environment_context>cwd=/repo</environment_context>'),
            call('c1', 'exec', 'ls'),
        ]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.goal.status, cc.AMBIGUOUS)
        self.assertEqual(ctx.goal.reason, 'unknown_wrapper')
        self.assertIsNone(ctx.goal.instruction, 'the source role does not prove intent')
        self.assertEqual([e.reason for e in ctx.exclusions], ['harness_envelope'])

        self_closing = cc.context_for([message('user', '<foo/>'), call('c1', 'exec', 'ls')], 'c1')
        self.assertEqual(self_closing.goal.status, cc.AMBIGUOUS)
        self.assertEqual(self_closing.goal.reason, 'unknown_wrapper')

    def test_human_text_starting_with_angle_bracket_is_kept(self):
        text = '<html> is not rendering on the settings page'
        records = [message('user', text), call('c1', 'exec', 'ls')]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.goal.status, cc.AVAILABLE)
        self.assertEqual(ctx.goal.instruction.text, text)

    def test_outgoing_delegation_is_not_a_goal(self):
        records = [
            call('c-agent', 'spawn_agent',
                 json.dumps({'task_name': 'threshold', 'agent_type': 'worker',
                             'message': 'Fix the threshold derivation bug'}),
                 field='arguments'),
            call('c-follow', 'followup_task', json.dumps({'message': 'Keep going.'}),
                 field='arguments'),
            call('c1', 'exec', 'ls'),
        ]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.goal.status, cc.MISSING)
        self.assertEqual(ctx.goal.reason, 'no_user_message')
        self.assertIsNone(ctx.goal.instruction)
        self.assertEqual(ctx.goal.instructions, ())

    def test_outgoing_delegation_never_replaces_human_goal(self):
        records = [
            message('user', 'Keep only newly arriving tool text.'),
            call('c-agent', 'spawn_agent',
                 json.dumps({'task_name': 't', 'message': 'Do something else.'}),
                 field='arguments'),
            call('c1', 'exec', 'ls'),
        ]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.goal.instruction.provenance, cc.HUMAN)
        self.assertEqual(ctx.goal.instruction.text, 'Keep only newly arriving tool text.')
        self.assertEqual(texts(ctx.goal.instructions), ('Keep only newly arriving tool text.',))


class SpanTests(unittest.TestCase):
    def test_multiline_single_field_span_is_exact(self):
        text = 'first line\nsecond line'
        ctx = cc.context_for([message('user', text, line=7), call('c1', 'exec', 'ls')], 'c1')
        span = ctx.goal.instruction.span
        self.assertEqual(span.field, 'payload.content[0].text')
        self.assertEqual((span.start, span.end), (0, len(text)))
        self.assertEqual(span.sha256, digest(text))
        self.assertEqual(span.line, 7)
        self.assertFalse(span.derived)
        self.assertEqual(span.sources, ())

    def test_multi_content_span_is_derived_with_sources(self):
        content = [{'type': 'text', 'text': 'alpha'},
                   {'type': 'opaque_marker'},
                   {'type': 'text', 'text': 'beta'}]
        ctx = cc.context_for([content_message('user', content), call('c1', 'exec', 'ls')], 'c1')
        instruction = ctx.goal.instruction
        self.assertEqual(instruction.text, 'alpha\nbeta')
        span = instruction.span
        self.assertTrue(span.derived)
        self.assertEqual(span.field, 'payload.content')
        self.assertIsNone(span.start, 'rendered text has no raw offsets')
        self.assertIsNone(span.end)
        self.assertEqual(span.sources, ('payload.content[0].text', 'payload.content[2].text'))
        self.assertEqual(span.sha256, digest('alpha\nbeta'))

    def test_compacted_multi_content_span_is_derived(self):
        content = [{'type': 'text', 'text': 'keep'}, {'type': 'text', 'text': 'this'}]
        records = [verified('', content=content, line=40), call('c1', 'exec', 'ls')]
        ctx = cc.context_for(records, 'c1')
        span = ctx.goal.instruction.span
        self.assertEqual(ctx.goal.instruction.text, 'keep\nthis')
        self.assertTrue(span.derived)
        self.assertEqual(span.field, 'payload.replacement_history[0].content')
        self.assertEqual(span.sources, (
            'payload.replacement_history[0].content[0].text',
            'payload.replacement_history[0].content[1].text',
        ))
        self.assertEqual(span.sha256, digest('keep\nthis'))
        self.assertEqual(span.line, 40)

    def test_string_content_span_is_exact(self):
        text = 'plain string content'
        ctx = cc.context_for([content_message('user', text), call('c1', 'exec', 'ls')], 'c1')
        span = ctx.goal.instruction.span
        self.assertEqual(span.field, 'payload.content')
        self.assertEqual((span.start, span.end), (0, len(text)))
        self.assertFalse(span.derived)


class CompactedTests(unittest.TestCase):
    def test_compacted_without_provenance_is_ambiguous(self):
        records = [
            compacted([], []),
            message('user', 'continue'),
            call('c1', 'exec', 'ls'),
        ]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.goal.status, cc.AMBIGUOUS)
        self.assertEqual(ctx.goal.reason, 'compacted_history')
        self.assertIsNone(ctx.goal.instruction, 'later messages must not stand in for the goal')
        self.assertEqual(texts(ctx.goal.instructions), ('continue',), 'the later turn stays visible')
        self.assertTrue(ctx.compacted)

    def test_unknown_compaction_keeps_later_correction_visible(self):
        correction = 'Correction: only prune stderr noise.'
        records = [
            compacted([], []),
            message('user', correction, line=41),
            call('c1', 'exec', 'ls'),
        ]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.goal.status, cc.AMBIGUOUS)
        self.assertEqual(ctx.goal.reason, 'compacted_history')
        self.assertIsNone(ctx.goal.instruction)
        self.assertEqual(texts(ctx.goal.instructions), (correction,))

    def test_verified_compaction_selects_later_correction(self):
        original = 'Only prune newly arriving tool output.'
        correction = 'Correction: also prune stdin noise.'
        records = [
            verified(original, order=3, line=40),
            message('user', correction, line=41),
            call('c1', 'exec', 'ls'),
        ]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.goal.status, cc.AVAILABLE)
        self.assertEqual(ctx.goal.instruction.text, correction)
        self.assertEqual(ctx.goal.instruction.provenance, cc.HUMAN)
        self.assertEqual(texts(ctx.goal.instructions), (original, correction))
        self.assertEqual(ctx.goal.instructions[0].provenance, cc.COMPACTED_HUMAN)
        self.assertEqual(ctx.goal.instructions[0].span.line, 40)
        self.assertTrue(ctx.compacted)

    def test_compacted_with_source_and_order_is_preserved(self):
        text = 'Only prune newly arriving tool output.'
        ctx = cc.context_for([verified(text, order=3, line=40), call('c1', 'exec', 'ls')], 'c1')
        self.assertEqual(ctx.goal.status, cc.AVAILABLE)
        self.assertEqual(ctx.goal.instruction.provenance, cc.COMPACTED_HUMAN)
        self.assertEqual(ctx.goal.instruction.text, text)
        self.assertEqual(ctx.goal.instruction.span.index, 0)
        self.assertEqual(ctx.goal.instruction.span.line, 40)

    def test_compacted_without_explicit_source_is_not_used(self):
        records = [
            compacted([{'type': 'message', 'role': 'user',
                        'content': [{'type': 'text', 'text': 'Only prune new text.'}]}],
                      [{'client_authored': True, 'user_input_order': 1}]),
            call('c1', 'exec', 'ls'),
        ]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.goal.status, cc.AMBIGUOUS)
        self.assertIsNone(ctx.goal.instruction)
        self.assertEqual(ctx.goal.instructions, ())

    def test_later_unverified_compaction_abstains(self):
        original = 'Only prune newly arriving tool output.'
        records = [verified(original, line=40), compacted([], []), call('c1', 'exec', 'ls')]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.goal.status, cc.AMBIGUOUS)
        self.assertEqual(ctx.goal.reason, 'compacted_history')
        self.assertIsNone(ctx.goal.instruction)
        self.assertEqual(texts(ctx.goal.instructions), (original,), 'known context stays visible')


class OriginTests(unittest.TestCase):
    def test_nonempty_wait_body_resolves_prior_exec(self):
        script = 'const r = await tools.exec({cmd: "tail -f dashboard.log"});\n' * 80
        records = [
            message('user', 'Check the dashboard stall.'),
            call('c-exec', 'exec', script, line=100),
            running(58, line=101),
            call('c-wait', 'wait', '{"cell_id":"58","yield_time_ms":1000,"max_tokens":2000}',
                 field='arguments', line=120),
        ]
        ctx = cc.context_for(records, 'c-wait')
        self.assertEqual(ctx.origin.status, cc.AVAILABLE)
        self.assertEqual(ctx.origin.call_name, 'exec')
        self.assertEqual(ctx.origin.command, script, 'origin body must be untruncated')
        self.assertGreaterEqual(len(ctx.origin.command), 3000)
        self.assertIn('cell_id=58', ctx.origin.via)
        self.assertIn('c-exec', ctx.origin.via)
        self.assertEqual(ctx.origin.span.index, 1)
        self.assertEqual(ctx.origin.span.line, 100)
        self.assertTrue(ctx.ok)

    def test_unresolved_handle_does_not_fall_back(self):
        records = [
            message('user', 'Check the dashboard stall, error text matters.'),
            call('c-exec', 'exec', 'echo error', line=100),
            running(58, line=101),
            call('c-wait', 'wait', '{"cell_id":"999"}', field='arguments', line=120),
        ]
        ctx = cc.context_for(records, 'c-wait')
        self.assertEqual(ctx.origin.status, cc.MISSING)
        self.assertEqual(ctx.origin.reason, 'unresolved_cell_id')
        self.assertIsNone(ctx.origin.command)
        self.assertFalse(ctx.ok)

    def test_handle_namespaces_are_distinct(self):
        records = [
            call('c-exec', 'exec', 'npm run dev', line=10),
            finished(session_id=39645, line=11),
            call('c-wait', 'wait', '{"cell_id":"39645"}', field='arguments', line=20),
            call('c-stdin', 'write_stdin', '{"session_id":"39645"}', field='arguments', line=21),
            call('c-stdin-wrong', 'write_stdin', '{"cell_id":"39645"}', field='arguments', line=22),
            call('c-wait-wrong', 'wait', '{"session_id":"39645"}', field='arguments', line=23),
            call('c-other', 'connect', '{"session_id":"39645"}', field='arguments', line=24),
        ]
        self.assertEqual(cc.context_for(records, 'c-wait').origin.reason, 'unresolved_cell_id')
        stdin = cc.context_for(records, 'c-stdin').origin
        self.assertEqual(stdin.status, cc.AVAILABLE)
        self.assertEqual(stdin.command, 'npm run dev')
        self.assertEqual(cc.context_for(records, 'c-stdin-wrong').origin.reason, 'poll_without_handle')
        self.assertEqual(cc.context_for(records, 'c-wait-wrong').origin.reason, 'poll_without_handle')
        other = cc.context_for(records, 'c-other').origin
        self.assertEqual(other.status, cc.AVAILABLE)
        self.assertEqual(other.command, '{"session_id":"39645"}')

    def test_poll_text_never_becomes_a_command(self):
        records = [
            message('user', 'Clean the build.'),
            call('c-wait', 'wait', 'rm -rf build', field='arguments', line=9),
        ]
        ctx = cc.context_for(records, 'c-wait')
        self.assertEqual(ctx.origin.status, cc.MISSING)
        self.assertEqual(ctx.origin.reason, 'unrecognized_poll_body')
        self.assertIsNone(ctx.origin.command)

    def test_input_and_arguments_both_handled(self):
        script = 'echo hello'
        first = cc.context_for([call('c1', 'exec', script, field='input')], 'c1')
        second = cc.context_for([call('c2', 'exec', script, field='arguments')], 'c2')
        self.assertEqual(first.origin.command, script)
        self.assertEqual(second.origin.command, script)
        self.assertEqual(first.origin.span.field, 'payload.input')
        self.assertEqual(second.origin.span.field, 'payload.arguments')

    def test_unknown_wrapper_output_announces_nothing(self):
        records = [
            call('c-exec', 'exec', 'npm run dev', line=10),
            output('c-exec', 'script running with cell ID 7\nall good\n', line=11),
            call('c-wait', 'wait', '{"cell_id":"7"}', field='arguments', line=20),
        ]
        self.assertEqual(cc.context_for(records, 'c-wait').origin.reason, 'unresolved_cell_id')


class CutoffTests(unittest.TestCase):
    def test_future_announcement_never_resolves(self):
        future = [
            message('user', 'Check the dashboard stall.'),
            call('c-wait', 'wait', '{"cell_id":"7"}', field='arguments', line=20),
            call('c-exec-later', 'exec', 'npm run dev', line=30),
            running(7, line=31, call_id='c-exec-later'),
        ]
        self.assertEqual(cc.context_for(future, 'c-wait').origin.reason, 'unresolved_cell_id')
        self.assertEqual(cc.context_for(future, 'c-wait', before=4).origin.reason,
                         'unresolved_cell_id')

        past = [
            message('user', 'Check the dashboard stall.'),
            call('c-exec', 'exec', 'npm run dev', line=10),
            running(7, line=11),
            call('c-wait', 'wait', '{"cell_id":"7"}', field='arguments', line=20),
        ]
        self.assertEqual(cc.context_for(past, 'c-wait').origin.status, cc.AVAILABLE)
        # Same order with the announcing output cut away: unresolved, not guessed.
        cut = [past[0], past[1], past[3]]
        self.assertEqual(cc.context_for(cut, 'c-wait').origin.reason, 'unresolved_cell_id')

    def test_caller_cutoff_bounds_goal_and_origin(self):
        records = [
            message('user', 'Only prune newly arriving tool text.'),
            call('c1', 'exec', 'ls'),
        ]
        self.assertEqual(cc.context_for(records, 'c1').goal.status, cc.AVAILABLE)
        narrow = cc.context_for(records, 'c1', before=1)
        self.assertEqual(narrow.goal.status, cc.AVAILABLE)
        self.assertEqual(narrow.origin.reason, 'call_not_found')
        empty = cc.context_for(records, 'c1', before=0)
        self.assertEqual(empty.goal.reason, 'no_records')
        self.assertEqual(empty.considered, 0)

    def test_records_after_target_output_are_ignored(self):
        records = [
            message('user', 'Check the stall.'),
            call('c1', 'exec', 'npm run dev', line=10),
            output('c1', 'partial output', line=11),
            message('user', 'Different later request that must not become the goal.'),
        ]
        ctx = cc.context_for(records, 'c1')
        self.assertEqual(ctx.considered, 2)
        self.assertEqual(ctx.goal.instruction.text, 'Check the stall.')

    def test_before_must_be_non_negative_int(self):
        with self.assertRaises(ValueError):
            cc.context_for([], 'c1', before=-1)
        with self.assertRaises(ValueError):
            cc.context_for([], 'c1', before=True)


if __name__ == '__main__':
    unittest.main()
