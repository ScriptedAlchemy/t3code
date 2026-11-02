"""Tests for the bounded lossless output-line adapter.

Synthetic fixtures only. They establish exact passthrough, exact splices and
range properties; they establish nothing about selection quality, tokens,
second-pass idempotence or provider cache behaviour.
"""
import hashlib
import json
import unittest

import output_lines as ol


def leaf(output, drop=(), **swap):
    obj = {
        'chunk_id': 'chunk_001',
        'wall_time_seconds': 1.5,
        'exit_code': 0,
        'original_token_count': 42,
        'output': output,
    }
    for key in drop:
        obj.pop(key)
    obj.update(swap)
    return json.dumps(obj, ensure_ascii=False)


def digest(raw):
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def expected_marker(raw, start, end):
    count = end - start
    if count == 1:
        where, detail = 'line %d' % (start + 1), ''
    else:
        where, detail = 'lines %d-%d' % (start + 1, end), ' (%d lines)' % count
    return '[t3.exec output %s omitted%s; source sha256 %s]' % (
        where, detail, digest(raw))


def decode(raw):
    result = ol.decode(raw, ol.PRODUCER)
    if not isinstance(result, ol.Decoded):
        raise AssertionError('expected a decoded envelope, got ' + result.reason)
    return result


class DecodeTest(unittest.TestCase):
    def test_excessive_nesting_abstains(self):
        raw = '{"output":' + '[' * 10000 + '0' + ']' * 10000 + '}'
        result = ol.decode(raw, ol.PRODUCER)
        self.assertIsInstance(result, ol.Abstained)
        self.assertEqual(result.reason, 'malformed-json')
        self.assertEqual(result.text, raw)


    def test_requires_one_process_status_shape(self):
        for raw in (leaf('x', drop=('exit_code',)), leaf('x', session_id=3)):
            with self.subTest(raw=raw):
                result = ol.decode(raw, ol.PRODUCER)
                self.assertIsInstance(result, ol.Abstained)
                self.assertEqual(result.reason, 'unknown-shape')
                self.assertEqual(result.text, raw)
        self.assertIsInstance(ol.decode(leaf('x', drop=('exit_code',), session_id=3),
                                      ol.PRODUCER), ol.Decoded)


    def test_lines_keep_exact_endings_and_original_numbers(self):
        raw = leaf('l1\nl2\r\nl3')
        decoded = decode(raw)
        self.assertEqual([line.number for line in decoded.lines], [1, 2, 3])
        self.assertEqual([line.text for line in decoded.lines], ['l1\n', 'l2\r\n', 'l3'])
        self.assertEqual(''.join(line.text for line in decoded.lines), decoded.output)
        self.assertEqual(decoded.source_sha256, digest(raw))
        self.assertEqual(decoded.raw, raw)
        self.assertEqual(decoded.producer, ol.PRODUCER)

    def test_metadata_is_the_non_output_members_in_order(self):
        decoded = decode(leaf('x'))
        self.assertEqual(list(decoded.metadata.items()), [
            ('chunk_id', 'chunk_001'),
            ('wall_time_seconds', 1.5),
            ('exit_code', 0),
            ('original_token_count', 42),
        ])
        with self.assertRaises(TypeError):
            decoded.metadata['chunk_id'] = 'other'

    def test_session_id_variant_without_exit_code(self):
        raw = json.dumps({
            'chunk_id': 'chunk_001',
            'wall_time_seconds': 1.5,
            'session_id': 9,
            'original_token_count': 42,
            'output': 'x',
        })
        decoded = decode(raw)
        self.assertEqual(list(decoded.metadata), [
            'chunk_id', 'wall_time_seconds', 'session_id', 'original_token_count'])
        self.assertEqual(decoded.metadata['session_id'], 9)

    def test_empty_output_exposes_no_lines(self):
        decoded = decode(leaf(''))
        self.assertEqual(decoded.lines, ())
        self.assertEqual(decoded.output, '')
        self.assertEqual(ol.render(decoded).envelope, leaf(''))

    def test_trailing_whitespace_after_the_object_is_allowed(self):
        raw = leaf('a\n') + '\n'
        decoded = decode(raw)
        self.assertEqual(decoded.raw, raw)
        self.assertEqual(ol.render(decoded).envelope, raw)

    def test_output_token_span_addresses_the_original_string_token(self):
        raw = leaf('a\nb')
        start, end = decode(raw).output_token_span
        self.assertEqual(raw[start:start + 1], '"')
        self.assertEqual(raw[end - 1:end], '"')
        self.assertEqual(json.loads(raw[start:end]), 'a\nb')

    def test_ascii_escaped_envelope_decodes_to_unicode_text(self):
        raw = json.dumps({
            'chunk_id': 'c',
            'exit_code': 0,
            'wall_time_seconds': 0,
            'original_token_count': 2,
            'output': 'caf\u00e9 \U0001F600\ntail\n',
        }, ensure_ascii=True)
        self.assertIn('\\u00e9', raw)
        decoded = decode(raw)
        self.assertEqual(decoded.lines[0].text, 'caf\u00e9 \U0001F600\n')
        rendered = ol.render(decoded, keep=[(0, 1)])
        self.assertIn('caf\u00e9 \U0001F600\n', rendered.text)
        self.assertNotIn('tail', rendered.text)
        self.assertEqual(json.loads(rendered.envelope)['output'], rendered.text)


class AbstainTest(unittest.TestCase):

    def test_producer_identity_is_required_and_explicit(self):
        raw = leaf('x')
        with self.assertRaises(TypeError):
            ol.decode(raw)
        other = ol.decode(raw, 't3.exec.v2')
        self.assertIsInstance(other, ol.Abstained)
        self.assertEqual(other.reason, 'producer-unknown')
        self.assertEqual(other.text, raw)
        self.assertEqual(ol.decode(raw, None).reason, 'producer-unknown')

    def test_duplicate_keys_abstain(self):
        raw = ('{"chunk_id":"c","exit_code":0,"wall_time_seconds":0,"original_token_count":1,'
               '"output":"a","output":"b"}')
        self.assertEqual(ol.decode(raw, ol.PRODUCER).reason, 'duplicate-key')

    def test_malformed_and_truncated_json_abstain(self):
        raw = leaf('a\nb\n')
        self.assertEqual(ol.decode(raw[:-3], ol.PRODUCER).reason, 'malformed-json')
        self.assertEqual(ol.decode(raw[:len(raw) // 2], ol.PRODUCER).reason, 'malformed-json')
        self.assertEqual(ol.decode('', ol.PRODUCER).reason, 'not-json')
        self.assertEqual(ol.decode('not json', ol.PRODUCER).reason, 'not-json')

    def test_bytes_after_the_object_abstain(self):
        raw = leaf('a\n')
        self.assertEqual(ol.decode(raw + ' trailing', ol.PRODUCER).reason, 'trailing-bytes')
        self.assertEqual(ol.decode(raw + '{}', ol.PRODUCER).reason, 'trailing-bytes')

    def test_typed_nontext_output_abstains(self):
        for output in (123, ['a', 'b'], {'text': 'a'}, None):
            raw = leaf(output)
            self.assertEqual(ol.decode(raw, ol.PRODUCER).reason, 'nontext', raw)

    def test_unknown_shapes_abstain(self):
        cases = [
            leaf('x', drop=('original_token_count',)),
            leaf('x', call_id='call_1'),
            leaf('x', wall_time_seconds=True),
            leaf('x', original_token_count='42'),
            leaf('x', exit_code='0'),
            leaf('x', chunk_id=1),
            leaf('x', exit_code=True),
        ]
        for raw in cases:
            self.assertEqual(ol.decode(raw, ol.PRODUCER).reason, 'unknown-shape', raw)

    def test_other_bare_exec_variants_are_not_supported(self):
        shapes = [
            json.dumps({'i': 0, 'status': 'fulfilled', 'value': {'output': 'x'}}),
            json.dumps({'i': 0, 'result': 'x'}),
            json.dumps({'content': [{'type': 'text', 'text': 'x'}],
                        'isError': False, 'structuredContent': {}}),
            'Warning: truncated output (original token count: 9)\nTotal output lines: 2\n\n'
            + leaf('x'),
        ]
        for raw in shapes:
            self.assertIsInstance(ol.decode(raw, ol.PRODUCER), ol.Abstained)

    def test_lone_surrogate_output_abstains(self):
        raw = ('{"chunk_id":"c","exit_code":0,"wall_time_seconds":0,"original_token_count":1,'
               '"output":"\\ud800"}')
        self.assertEqual(ol.decode(raw, ol.PRODUCER).reason, 'unsupported-encoding')

    def test_abstained_result_has_no_lines(self):
        result = ol.decode(leaf('a'), 'other')
        self.assertFalse(hasattr(result, 'lines'))
        with self.assertRaises(TypeError):
            ol.render(result)

    def test_every_abstention_reason_is_declared(self):
        raws = [
            leaf('x', drop=('output',)),                # unknown-shape
            leaf('x', call_id='call_1'),                # unknown-shape
            leaf(123),                                  # nontext
            'nope',                                     # not-json
            '{"a":1,"a":2}',                            # duplicate-key
            leaf('x') + ' trailing',                    # trailing-bytes
            ('{"chunk_id":"c","exit_code":0,"wall_time_seconds":0,"original_token_count":1,'
             '"output":"\\ud800"}'),                    # unsupported-encoding
        ]
        reasons = set()
        for raw in raws:
            result = ol.decode(raw, ol.PRODUCER)
            self.assertIsInstance(result, ol.Abstained)
            self.assertIn(result.reason, ol.ABSTAIN_REASONS)
            reasons.add(result.reason)
        reasons.add(ol.decode(leaf('x'), 'other').reason)
        self.assertEqual(reasons, {
            'producer-unknown', 'unknown-shape', 'nontext', 'not-json',
            'duplicate-key', 'trailing-bytes', 'unsupported-encoding'})


class RenderTest(unittest.TestCase):

    def test_noop_is_the_original_string_by_identity(self):
        raw = leaf('a\r\nb\nc')
        decoded = decode(raw)
        rendered = ol.render(decoded)
        self.assertIs(rendered.envelope, decoded.raw)
        self.assertEqual(rendered.envelope, raw)
        self.assertEqual(rendered.text, decoded.output)
        self.assertEqual(rendered.kept, decoded.lines)
        self.assertEqual(rendered.omissions, ())
        self.assertEqual(rendered.removed_chars, 0)
        self.assertEqual(rendered.marker_chars, 0)

    def test_keeping_every_line_is_a_noop(self):
        raw = leaf('a\nb\n')
        decoded = decode(raw)
        rendered = ol.render(decoded, keep=[(0, len(decoded.lines))])
        self.assertEqual(rendered.envelope, raw)
        self.assertEqual(rendered.omissions, ())

    def test_middle_removal_renders_one_marker_at_original_coordinates(self):
        raw = leaf('l1\nl2\nl3\nl4\nl5\nl6\n')
        decoded = decode(raw)
        rendered = ol.render(decoded, keep=[(0, 1), (2, 6)])
        marker = expected_marker(raw, 1, 2)
        self.assertEqual(rendered.omissions[0].start, 1)
        self.assertEqual(rendered.omissions[0].end, 2)
        self.assertEqual(rendered.omissions[0].marker, marker)
        self.assertEqual(rendered.omissions[0].source_sha256, digest(raw))
        self.assertEqual(rendered.text, 'l1\n' + marker + '\nl3\nl4\nl5\nl6\n')
        self.assertEqual(rendered.removed_chars, len('l2\n'))
        self.assertEqual(rendered.marker_chars, len(marker) + 1)
        self.assertEqual(json.loads(rendered.envelope)['output'], rendered.text)

    def test_adjacent_removals_coalesce_into_one_marker(self):
        raw = leaf('l1\nl2\nl3\nl4\nl5\nl6\n')
        rendered = ol.render(decode(raw), keep=[(0, 2), (4, 6)])
        marker = expected_marker(raw, 2, 4)
        self.assertEqual(len(rendered.omissions), 1)
        self.assertEqual(rendered.omissions[0].start, 2)
        self.assertEqual(rendered.omissions[0].end, 4)
        self.assertIn('(2 lines)', marker)
        self.assertEqual(rendered.text, 'l1\nl2\n' + marker + '\nl5\nl6\n')

    def test_disjoint_removals_render_two_markers(self):
        raw = leaf('l1\nl2\nl3\nl4\nl5\nl6\n')
        rendered = ol.render(decode(raw), keep=[(0, 1), (2, 3), (4, 6)])
        first, second = expected_marker(raw, 1, 2), expected_marker(raw, 3, 4)
        self.assertEqual([om.start for om in rendered.omissions], [1, 3])
        self.assertEqual([om.end for om in rendered.omissions], [2, 4])
        self.assertEqual(
            rendered.text,
            'l1\n' + first + '\nl3\n' + second + '\nl5\nl6\n')

    def test_tail_without_a_final_newline_keeps_that_shape(self):
        raw = leaf('a\nb')
        rendered = ol.render(decode(raw), keep=[(0, 1)])
        marker = expected_marker(raw, 1, 2)
        self.assertEqual(rendered.text, 'a\n' + marker)
        self.assertEqual(rendered.marker_chars, len(marker))
        self.assertFalse(rendered.text.endswith('\n'))

    def test_removing_every_line_leaves_one_marker(self):
        raw = leaf('x\ny\n')
        rendered = ol.render(decode(raw), keep=[])
        self.assertEqual(len(rendered.omissions), 1)
        self.assertEqual(rendered.omissions[0].start, 0)
        self.assertEqual(rendered.omissions[0].end, 2)
        self.assertEqual(rendered.text, expected_marker(raw, 0, 2) + '\n')
        self.assertEqual(rendered.kept, ())

    def test_crlf_lines_are_retained_verbatim(self):
        raw = leaf('a\r\nb\r\nc\r\n')
        decoded = decode(raw)
        self.assertEqual([line.text for line in decoded.lines],
                         ['a\r\n', 'b\r\n', 'c\r\n'])
        rendered = ol.render(decoded, keep=[(0, 1), (2, 3)])
        marker = expected_marker(raw, 1, 2)
        self.assertEqual(rendered.text, 'a\r\n' + marker + '\r\nc\r\n')
        self.assertEqual(rendered.kept[0].text, 'a\r\n')
        self.assertEqual(rendered.kept[1].text, 'c\r\n')

    def test_escaped_quotes_backslashes_and_unicode_survive(self):
        output = 'quote " backslash \\ tab\t caf\u00e9 \U0001F600\nsecond "line" \\n\n'
        raw = leaf(output)
        rendered = ol.render(decode(raw), keep=[(1, 2)])
        marker = expected_marker(raw, 0, 1)
        self.assertEqual(rendered.text, marker + '\n' + 'second "line" \\n\n')
        self.assertEqual(json.loads(rendered.envelope)['output'], rendered.text)

    def test_nested_json_stdout_stays_text(self):
        inner = json.dumps({
            'audit': [{'id': i, 'ok': True} for i in range(3)],
            'schema': {'type': 'object'},
        }, indent=2)
        raw = leaf(inner)
        decoded = decode(raw)
        self.assertGreater(len(decoded.lines), 4)
        self.assertEqual(''.join(line.text for line in decoded.lines), inner)
        rendered = ol.render(decoded, keep=[(0, 4), (5, len(decoded.lines))])
        self.assertEqual(rendered.omissions[0].start, 4)
        self.assertEqual(rendered.omissions[0].end, 5)
        self.assertIn('  "schema": {', rendered.text)
        self.assertEqual(json.loads(rendered.envelope)['output'], rendered.text)
        self.assertIsInstance(json.loads(rendered.envelope)['output'], str)

    def test_only_the_output_token_changes(self):
        raw = leaf('l1\nl2\nl3\n', session_id=7, drop=('exit_code',))
        decoded = decode(raw)
        rendered = ol.render(decoded, keep=[(0, 1), (2, 3)])
        start, end = decoded.output_token_span
        token = json.dumps(rendered.text, ensure_ascii=False)
        self.assertEqual(rendered.envelope[:start], raw[:start])
        self.assertEqual(rendered.envelope[start + len(token):], raw[end:])

    def test_metadata_and_member_order_are_preserved(self):
        raw = ('{"output":"l1\\nl2\\nl3\\n","session_id":9,"chunk_id":"c",'
               '"wall_time_seconds":2,"original_token_count":3}')
        decoded = decode(raw)
        rendered = ol.render(decoded, keep=[(0, 1)])
        pairs = json.loads(rendered.envelope, object_pairs_hook=lambda p: p)
        self.assertEqual([key for key, _ in pairs],
                         ['output', 'session_id', 'chunk_id',
                          'wall_time_seconds', 'original_token_count'])
        original_pairs = json.loads(raw, object_pairs_hook=lambda p: p)
        self.assertEqual([pair for pair in pairs if pair[0] != 'output'],
                         [pair for pair in original_pairs if pair[0] != 'output'])
        self.assertEqual(decoded.metadata['session_id'], 9)

    def test_marker_and_removed_sizes_are_characters(self):
        raw = leaf('l1\nl2\nl3\nl4\n')
        decoded = decode(raw)
        rendered = ol.render(decoded, keep=[(0, 1), (3, 4)])
        removed = ''.join(line.text for line in decoded.lines[1:3])
        kept = ''.join(line.text for line in rendered.kept)
        self.assertEqual(rendered.removed_chars, len(removed))
        self.assertEqual(rendered.marker_chars,
                         len(rendered.omissions[0].marker) + 1)
        self.assertEqual(len(rendered.text), len(kept) + rendered.marker_chars)

    def test_invalid_keep_ranges_raise(self):
        decoded = decode(leaf('l1\nl2\nl3\n'))
        bad = [
            [(0, 0)],
            [(0, 4)],
            [(-1, 1)],
            [(2, 1)],
            [(0, 2), (1, 3)],
            [(True, 2)],
            [('0', 2)],
            [0],
        ]
        for keep in bad:
            with self.assertRaises(ValueError, msg=repr(keep)):
                ol.render(decoded, keep=keep)

    def test_adjacent_keep_ranges_are_equivalent_to_one(self):
        raw = leaf('l1\nl2\nl3\n')
        decoded = decode(raw)
        split = ol.render(decoded, keep=[(0, 1), (1, 2)])
        whole = ol.render(decoded, keep=[(0, 2)])
        self.assertEqual(split.envelope, whole.envelope)
        self.assertEqual(split.omissions[0].start, 2)


class OmittedTextTest(unittest.TestCase):

    def test_reconstructs_exact_original_bytes_from_the_source(self):
        raw = leaf('a\nb\r\nc')
        source = digest(raw)
        self.assertEqual(ol.omitted_text(raw, ol.PRODUCER, source, 0, 1), 'a\n')
        self.assertEqual(ol.omitted_text(raw, ol.PRODUCER, source, 1, 3), 'b\r\nc')

    def test_mismatched_source_digest_raises(self):
        raw = leaf('a\nb\n')
        with self.assertRaises(ValueError):
            ol.omitted_text(raw, ol.PRODUCER, digest(raw + 'x'), 0, 1)
        with self.assertRaises(ValueError):
            ol.omitted_text(raw, ol.PRODUCER, None, 0, 1)
        with self.assertRaises(ValueError):
            ol.omitted_text(raw + 'x', ol.PRODUCER, digest(raw), 0, 1)

    def test_unsupported_representation_raises(self):
        raw = leaf('a\n')
        with self.assertRaises(ValueError):
            ol.omitted_text(raw, 'other', digest(raw), 0, 1)

    def test_invalid_ranges_raise(self):
        raw = leaf('a\nb\n')
        source = digest(raw)
        for start, end in ((0, 0), (1, 1), (-1, 1), (0, 3), (2, 1), (True, 1)):
            with self.assertRaises(ValueError, msg=(start, end)):
                ol.omitted_text(raw, ol.PRODUCER, source, start, end)


if __name__ == '__main__':
    unittest.main()
