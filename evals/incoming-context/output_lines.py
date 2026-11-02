"""Lossless decoded-line view of one verified bare exec-result envelope.

Evaluator-only prototype. It is not wired into selection, scoring, chunking or
delivery, it performs no inference, and it claims nothing about tokens,
second-pass idempotence, provider cache identity or semantic safety.

Supported representation (the only one)
---------------------------------------
A text leaf that is *entirely* one JSON object, with exactly these members:

  required  chunk_id              str
            wall_time_seconds     int or finite float
            original_token_count  int
            output                str
  optional  exit_code             int
            session_id            int

Read-only verification against the 295 exec-result leaves of this evaluation's
``cases.json``: 277 carry ``exit_code``, 18 carry ``session_id``, none carries
another key, every leaf is the whole block, and none has bytes after the
object. Member order in that corpus is ``chunk_id, wall_time_seconds,
exit_code|session_id, original_token_count, output``; this module does not
require an order, because it never reserializes the envelope.

Everything else abstains and the caller keeps the original string: another
producer id, another key set, another member type, a duplicate key, malformed
or truncated JSON, bytes after the object, a non-string ``output``, or text
that cannot be decoded to UTF-8.

What is exposed
---------------
``decode`` returns the exact decoded lines (ending included, ``\\n`` is the only
split point, so CRLF and a missing final newline survive), the SHA-256 of the
original string, the read-only command-result metadata and the character span
of the ``output`` JSON string token.

``render`` takes the caller's *kept* half-open original line ranges, derives
the contiguous omitted ranges, and returns the rendered text plus the whole
envelope string. Only the ``output`` string token is replaced, with
``json.dumps(..., ensure_ascii=False)``; every byte around it, member order
and every other member are the original bytes. With no omission the original
string is returned unchanged.

``omitted_text`` reconstructs an omitted range from the authoritative original
string and a caller-verified digest. No copy of removed lines is stored here.

Sizes in ``Render`` are characters, not tokens. Marker cost is character
overhead; whether it expands or saves tokens is an evaluation question, not
something this module asserts.
"""
from __future__ import annotations

from json_bounds import exceeds_depth

import hashlib
import json
import math
from dataclasses import dataclass
from types import MappingProxyType

__all__ = [
    'PRODUCER',
    'ABSTAIN_REASONS',
    'Line',
    'Decoded',
    'Abstained',
    'Omission',
    'Render',
    'decode',
    'render',
    'omitted_text',
]

PRODUCER = 't3.exec.v1'

_REQUIRED_KEYS = frozenset({'chunk_id', 'wall_time_seconds',
                            'original_token_count', 'output'})
_ALLOWED_KEYS = _REQUIRED_KEYS | {'exit_code', 'session_id'}

ABSTAIN_REASONS = frozenset({
    'producer-unknown',
    'not-json',
    'malformed-json',
    'duplicate-key',
    'trailing-bytes',
    'unknown-shape',
    'nontext',
    'unverified-span',
    'unsupported-encoding',
})

_WS = ' \t\r\n'


@dataclass(frozen=True)
class Line:
    """One original decoded line, ending included."""

    number: int  # 1-based ordinal in the original decoded text
    text: str    # exact decoded bytes of this line, line ending included


@dataclass(frozen=True)
class Decoded:
    """A verified bare exec-result envelope, decoded losslessly."""

    producer: str
    raw: str                       # the original leaf string, unchanged
    source_sha256: str             # sha256 of raw as UTF-8
    output: str                    # the decoded stdout text
    lines: tuple[Line, ...]        # exact original lines, ending included
    metadata: MappingProxyType     # non-output members, original order, read-only
    output_token_span: tuple[int, int]  # (start, end) of the JSON string token in raw


@dataclass(frozen=True)
class Abstained:
    """The original string is returned untouched; no lines are exposed."""

    reason: str
    text: str


@dataclass(frozen=True)
class Omission:
    """One contiguous removed range, in half-open 0-based original line ordinals.

    ``marker`` displays the same lines as 1-based inclusive coordinates and
    carries the full source digest.
    """

    start: int          # 0-based, inclusive
    end: int            # 0-based, exclusive
    marker: str         # the exact replacement line text, ending excluded
    source_sha256: str

    @property
    def count(self) -> int:
        return self.end - self.start


@dataclass(frozen=True)
class Render:
    """A rendered result. Char counts are not token claims."""

    producer: str
    source_sha256: str
    text: str                  # decoded rendered text, markers included
    envelope: str              # whole leaf string with only output token replaced
    kept: tuple[Line, ...]
    omissions: tuple[Omission, ...]
    removed_chars: int         # characters removed, line endings included
    marker_chars: int          # marker characters added, endings included


class _DuplicateKey(ValueError):
    pass


def _unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise _DuplicateKey(key)
        obj[key] = value
    return obj


_DECODER = json.JSONDecoder(object_pairs_hook=_unique_object)
_SCAN = json.JSONDecoder()


def _first_non_space(text):
    i = 0
    while i < len(text) and text[i] in _WS:
        i += 1
    return i


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value)


def _member_spans(raw, start, end):
    """(key, value_start, value_end) for each top-level member.

    A narrow scan over one object only: values are skipped with ``raw_decode``,
    so this reads no nesting itself and builds no per-character map.
    """
    if raw[start] != '{':
        raise ValueError('not an object')
    spans = []
    i = start + 1
    while True:
        while i < end and raw[i] in _WS:
            i += 1
        if i >= end:
            raise ValueError('unterminated object')
        if raw[i] == '}':
            return spans
        key, i = _SCAN.raw_decode(raw, i)
        if not isinstance(key, str):
            raise ValueError('member name is not a string')
        while i < end and raw[i] in _WS:
            i += 1
        if i >= end or raw[i] != ':':
            raise ValueError('missing member colon')
        i += 1
        while i < end and raw[i] in _WS:
            i += 1
        if i >= end:
            raise ValueError('missing member value')
        value_start = i
        _, i = _SCAN.raw_decode(raw, i)
        spans.append((key, value_start, i))
        while i < end and raw[i] in _WS:
            i += 1
        if i >= end:
            raise ValueError('unterminated object')
        if raw[i] == ',':
            i += 1
            continue
        if raw[i] == '}':
            return spans
        raise ValueError('bad member separator')


def _output_span(raw, start, end):
    for key, value_start, value_end in _member_spans(raw, start, end):
        if key == 'output':
            if raw[value_start] != '"' or raw[value_end - 1] != '"':
                raise ValueError('output is not a string token')
            return value_start, value_end
    raise ValueError('no output member')


def _split_lines(text):
    """Split on '\\n' only, keeping each ending, and never inventing a last line."""
    lines = []
    start = 0
    while True:
        newline = text.find('\n', start)
        if newline < 0:
            if start < len(text):
                lines.append(Line(len(lines) + 1, text[start:]))
            return tuple(lines)
        lines.append(Line(len(lines) + 1, text[start:newline + 1]))
        start = newline + 1
        if start == len(text):
            return tuple(lines)


def decode(raw, producer):
    """Decode one verified bare exec-result leaf.

    ``producer`` is the caller's producer identity and is required: a different
    value abstains without inspecting ``raw``. Returns ``Decoded`` or
    ``Abstained``; it never edits the caller's text.
    """
    if not isinstance(raw, str):
        raise TypeError('raw must be the original JSON text as str')
    if producer != PRODUCER:
        return Abstained('producer-unknown', raw)

    start = _first_non_space(raw)
    if start >= len(raw) or raw[start] != '{':
        return Abstained('not-json', raw)
    if exceeds_depth(raw, start):
        return Abstained('malformed-json', raw)
    try:
        obj, end = _DECODER.raw_decode(raw, start)
    except _DuplicateKey:
        return Abstained('duplicate-key', raw)
    except (ValueError, RecursionError):
        return Abstained('malformed-json', raw)
    if raw[end:].strip(_WS):
        return Abstained('trailing-bytes', raw)
    if not isinstance(obj, dict):
        return Abstained('not-json', raw)

    keys = frozenset(obj)
    if not _REQUIRED_KEYS <= keys or (keys - _ALLOWED_KEYS):
        return Abstained('unknown-shape', raw)
    if len(keys & {'exit_code', 'session_id'}) != 1:
        return Abstained('unknown-shape', raw)
    if not isinstance(obj['chunk_id'], str):
        return Abstained('unknown-shape', raw)
    if not _is_int(obj['original_token_count']):
        return Abstained('unknown-shape', raw)
    if not _is_number(obj['wall_time_seconds']):
        return Abstained('unknown-shape', raw)
    if 'exit_code' in obj and not _is_int(obj['exit_code']):
        return Abstained('unknown-shape', raw)
    if 'session_id' in obj and not _is_int(obj['session_id']):
        return Abstained('unknown-shape', raw)
    if not isinstance(obj['output'], str):
        return Abstained('nontext', raw)

    try:
        span = _output_span(raw, start, end)
    except ValueError:
        return Abstained('unverified-span', raw)
    try:
        if json.loads(raw[span[0]:span[1]]) != obj['output']:
            return Abstained('unverified-span', raw)
    except ValueError:
        return Abstained('unverified-span', raw)

    try:
        raw.encode('utf-8')
        obj['output'].encode('utf-8')
    except UnicodeEncodeError:
        return Abstained('unsupported-encoding', raw)

    metadata = {key: value for key, value in obj.items() if key != 'output'}
    return Decoded(
        producer=producer,
        raw=raw,
        source_sha256=hashlib.sha256(raw.encode('utf-8')).hexdigest(),
        output=obj['output'],
        lines=_split_lines(obj['output']),
        metadata=MappingProxyType(metadata),
        output_token_span=span,
    )


def _normalize_keep(keep, count):
    pairs = []
    for pair in keep:
        try:
            start, end = pair
        except (TypeError, ValueError) as exc:
            raise ValueError('each kept range must be a (start, end) pair') from exc
        if isinstance(start, bool) or not isinstance(start, int) \
                or isinstance(end, bool) or not isinstance(end, int):
            raise ValueError('kept range ordinals must be ints')
        if not 0 <= start < end <= count:
            raise ValueError('kept range %r is outside 0..%d' % ((start, end), count))
        pairs.append((start, end))
    pairs.sort()
    merged = []
    for start, end in pairs:
        if merged and start < merged[-1][1]:
            raise ValueError('kept ranges overlap')
        if merged and start == merged[-1][1]:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return tuple(merged)


def _complement(kept, count):
    gaps = []
    position = 0
    for start, end in kept:
        if position < start:
            gaps.append((position, start))
        position = end
    if position < count:
        gaps.append((position, count))
    return tuple(gaps)


def _marker(start, end, source_sha256):
    count = end - start
    if count == 1:
        where, detail = 'line %d' % (start + 1), ''
    else:
        where, detail = 'lines %d-%d' % (start + 1, end), ' (%d lines)' % count
    return '[t3.exec output %s omitted%s; source sha256 %s]' % (
        where, detail, source_sha256)


def _line_ending(text):
    if text.endswith('\r\n'):
        return '\r\n'
    if text.endswith('\n'):
        return '\n'
    return ''


def _verify_untouched(decoded, envelope, text, token):
    """Fail closed unless only the output token changed and it decodes back."""
    start, end = decoded.output_token_span
    if envelope[:start] != decoded.raw[:start]:
        raise AssertionError('bytes before the output token changed')
    if envelope[start + len(token):] != decoded.raw[end:]:
        raise AssertionError('bytes after the output token changed')
    first = _first_non_space(envelope)
    try:
        obj, stop = _SCAN.raw_decode(envelope, first)
    except ValueError as exc:
        raise AssertionError('rewritten envelope does not decode') from exc
    if envelope[stop:].strip(_WS):
        raise AssertionError('rewritten envelope has trailing bytes')
    if not isinstance(obj, dict):
        raise AssertionError('rewritten envelope is not an object')
    before = list(decoded.metadata.items())
    after = [(key, value) for key, value in obj.items() if key != 'output']
    if after != before:
        raise AssertionError('non-output members changed')
    if obj['output'] != text:
        raise AssertionError('retained decoded bytes changed')


def render(decoded, keep=None):
    """Render ``decoded`` retaining the caller's half-open original line ranges.

    ``keep`` lists ``(start, end)`` half-open, 0-based original line ordinals.
    ``None`` keeps every line and returns the original string unchanged. Gaps
    between kept ranges become one omission marker per contiguous range.
    """
    if not isinstance(decoded, Decoded):
        raise TypeError('render needs a Decoded result; an abstention keeps the original text')
    count = len(decoded.lines)
    if keep is None:
        kept_ranges = ((0, count),) if count else ()
    else:
        kept_ranges = _normalize_keep(keep, count)
    omitted = _complement(kept_ranges, count)

    if not omitted:
        return Render(
            producer=decoded.producer,
            source_sha256=decoded.source_sha256,
            text=decoded.output,
            envelope=decoded.raw,
            kept=decoded.lines,
            omissions=(),
            removed_chars=0,
            marker_chars=0,
        )

    parts = []
    kept = []
    omissions = []
    removed_chars = 0
    marker_chars = 0
    position = 0
    for start, end in omitted:
        kept.extend(decoded.lines[position:start])
        parts.extend(line.text for line in decoded.lines[position:start])
        removed = ''.join(line.text for line in decoded.lines[start:end])
        marker = _marker(start, end, decoded.source_sha256)
        ending = _line_ending(removed)
        parts.append(marker + ending)
        omissions.append(Omission(start, end, marker, decoded.source_sha256))
        removed_chars += len(removed)
        marker_chars += len(marker) + len(ending)
        position = end
    kept.extend(decoded.lines[position:])
    parts.extend(line.text for line in decoded.lines[position:])
    text = ''.join(parts)

    if len(text) != sum(len(line.text) for line in kept) + marker_chars:
        raise AssertionError('rendered text is not retained bytes plus markers')

    token = json.dumps(text, ensure_ascii=False)
    token_start, token_end = decoded.output_token_span
    envelope = decoded.raw[:token_start] + token + decoded.raw[token_end:]
    _verify_untouched(decoded, envelope, text, token)
    return Render(
        producer=decoded.producer,
        source_sha256=decoded.source_sha256,
        text=text,
        envelope=envelope,
        kept=tuple(kept),
        omissions=tuple(omissions),
        removed_chars=removed_chars,
        marker_chars=marker_chars,
    )


def omitted_text(raw, producer, source_sha256, start, end):
    """Reconstruct one omitted half-open original line range from the source.

    ``raw`` is the authoritative original string and ``source_sha256`` the
    digest the caller verified for it. A mismatch, an unsupported
    representation or an invalid range raises ``ValueError``; no removed text
    is stored anywhere by this module.
    """
    if not isinstance(raw, str):
        raise TypeError('raw must be the original JSON text as str')
    if not isinstance(source_sha256, str) \
            or hashlib.sha256(raw.encode('utf-8')).hexdigest() != source_sha256:
        raise ValueError('source digest does not match the original string')
    decoded = decode(raw, producer)
    if isinstance(decoded, Abstained):
        raise ValueError('not a supported envelope: ' + decoded.reason)
    if isinstance(start, bool) or not isinstance(start, int) \
            or isinstance(end, bool) or not isinstance(end, int):
        raise ValueError('line ordinals must be ints')
    if not 0 <= start < end <= len(decoded.lines):
        raise ValueError('omitted range is outside the decoded lines')
    return ''.join(line.text for line in decoded.lines[start:end])
