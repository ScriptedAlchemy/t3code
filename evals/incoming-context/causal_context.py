"""Causal context for one tool result: what was knowable *before* it.

Pure, read-only extraction over ordered rollout records. Nothing here executes
transcript code, calls a model, decrypts anything, or rewrites an earlier byte.
Absent or ambiguous evidence stays absent: every field carries an explicit
``available`` / ``missing`` / ``ambiguous`` status plus the reason.

API
---
    ctx = context_for(records, call_id)            # caller passes pre-cutoff records
    ctx = context_for(records, call_id, before=N)  # or let the caller bound it here

    ctx.goal.status                  # 'available' | 'missing' | 'ambiguous'
    ctx.goal.instruction             # latest sourced user instruction, or None
    ctx.goal.instructions            # every sourced user instruction, in order
    ctx.goal.instruction.span        # (record index, field, start, end, sha256)
    ctx.origin.command               # full originating call body; never truncated
    ctx.origin.via                   # 'cell_id=58 -> exec call_id=... line=...' or None
    ctx.ok                           # goal and origin both available

Goal provenance
---------------
Only a readable ``user`` message is a user instruction. Developer text, known
harness envelopes, and opaque content are refused. An unknown ``<tag>`` that
wraps the whole message is not guessed either way: it makes the goal ambiguous
instead of silently dropping what may be a real request.

Outgoing ``spawn_agent`` / ``followup_task`` calls are instructions *to other
agents*, so no call record is read as this agent's delegated brief.

A compaction record splits the stream. Instructions surviving in
``replacement_history`` count only when the record carries explicit client
authorship, retained source and input order. When the last compaction has no
such provenance, the pre-compaction goal is unknown and the goal abstains while
``goal.instructions`` still exposes every later user request. When compaction
is verified, a later user request is the selected instruction; an older
compacted goal never replaces it.

Spans
-----
Text read from exactly one content field carries that field's real path and
offsets. Text rendered from several text fields (joined with newlines) is
marked ``derived``: no raw offsets are claimed, only the constituent paths.

Record shape
------------
One mapping per rollout JSONL line (a Codex/T3 session record)::

    {'type': 'response_item',                  # 'compacted' records also recognized
     'payload': {...},                         # required
     'line': 421,                              # optional 1-based source line
     'timestamp': '...', 'ordinal': 3}         # optional, unused here

Recognized ``payload`` shapes:

* ``message`` with ``role`` in ``user`` / ``developer`` / ``assistant`` and
  ``content`` as a string, a dict, or a list of text items; ``encrypted_content``
  and image items mark the record opaque.
* ``custom_tool_call`` / ``function_call`` with ``call_id``, ``name`` and the
  body in ``input`` (custom tool) or ``arguments`` (function tool); the body is
  kept whole.
* ``custom_tool_call_output`` / ``function_call_output`` linked by ``call_id``.
* ``compacted`` with ``replacement_history`` plus
  ``replacement_history_metadata`` (explicit per-entry source/order).

Anything else is ignored. Unknown wrappers are never interpreted.

Poll resolution
---------------
A poll call is recognized by *call name first*, then by its scoped handle::

    wait        -> arguments.cell_id      (announced by 'Script running with cell ID <v>')
    write_stdin -> arguments.session_id   (announced by an exec envelope's "session_id")

Semantics are decided before the argument body, so a non-empty ``wait`` body is
never mistaken for a command. The handle must be announced in a PRIOR output
linked to a prior call by ``call_id``; that producing call's body is the origin.
Handles are namespaced: a ``cell_id`` never matches a ``session_id``
announcement. Unknown or missing announcements leave the origin unresolved.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass

AVAILABLE = 'available'
MISSING = 'missing'
AMBIGUOUS = 'ambiguous'

HUMAN = 'human'
COMPACTED_HUMAN = 'compacted_human'

CALL_TYPES = frozenset({'custom_tool_call', 'function_call'})
OUTPUT_TYPES = frozenset({'custom_tool_call_output', 'function_call_output'})

# Scoped poll handles: call name -> the one argument key that carries its handle.
POLL_HANDLES = {'wait': 'cell_id', 'write_stdin': 'session_id'}
# Namespaced handle -> the call name allowed to announce it.
ANNOUNCERS = {'cell_id': 'exec', 'session_id': 'exec'}

# Repository instructions, not a user request.
DOC_ENVELOPE_PREFIX = '# AGENTS.md instructions'
# Known harness wrappers that never carry a human instruction.
KNOWN_ENVELOPE_TAGS = frozenset({'environment_context', 'turn_aborted', 'subagent_notification'})
# Unrecognized wrapper: the source role does not settle intent, so abstain.
AMBIGUOUS_REASONS = frozenset({'unknown_wrapper'})

_WRAPPER_RUNNING = re.compile(r'^Script running with cell ID ([0-9A-Za-z_.:-]+)$')
_WRAPPER_FINISHED = re.compile(
    r'^(?:Script completed|Script failed|aborted before dispatch|aborted by user after [0-9.]+s)$'
)
_ENVELOPE_LINE = re.compile(r'^\{"chunk_id":')
_ENVELOPE_SESSION = re.compile(r'"session_id"\s*:\s*"?([0-9A-Za-z_.:-]+)"?')
_TAG = re.compile(r'<([A-Za-z_][A-Za-z0-9_-]*)(?:\s[^>]*)?/?>')
_OPAQUE_TYPES = frozenset({'encrypted_content', 'encrypted', 'refusal', 'input_image', 'image'})


@dataclass(frozen=True)
class Span:
    """Where a piece of text came from in the caller's record sequence."""

    index: int          # 0-based position in the records passed to context_for
    field: str          # exact field path, or the rendering root when derived
    start: int | None   # None when the text is a rendering of several fields
    end: int | None
    sha256: str
    line: int | None = None   # source line when the record carries one
    derived: bool = False     # text was joined from several fields
    sources: tuple[str, ...] = ()   # constituent field paths when derived


@dataclass(frozen=True)
class Instruction:
    provenance: str     # 'human' | 'compacted_human'
    text: str
    span: Span


@dataclass(frozen=True)
class Goal:
    status: str
    instruction: Instruction | None
    reason: str | None
    instructions: tuple[Instruction, ...] = ()   # every sourced user turn, in order

    @property
    def available(self) -> bool:
        return self.status == AVAILABLE


@dataclass(frozen=True)
class Origin:
    status: str
    call_name: str | None
    command: str | None      # full call body, untruncated
    span: Span | None
    via: str | None          # identifier -> producing call, or None when self-describing
    reason: str | None

    @property
    def available(self) -> bool:
        return self.status == AVAILABLE


@dataclass(frozen=True)
class Exclusion:
    reason: str
    count: int
    first_index: int
    first_line: int | None


@dataclass(frozen=True)
class Context:
    call_id: str
    goal: Goal
    origin: Origin
    considered: int
    exclusions: tuple[Exclusion, ...]
    compacted: bool

    @property
    def ok(self) -> bool:
        """True only when both halves are positively established."""
        return self.goal.status == AVAILABLE and self.origin.status == AVAILABLE

    @property
    def missing(self) -> tuple[str, ...]:
        return tuple(r for r in (self.goal.reason, self.origin.reason) if r)


def _payload(record):
    if not isinstance(record, dict):
        return {}
    payload = record.get('payload')
    return payload if isinstance(payload, dict) else {}


def _line(record):
    line = record.get('line') if isinstance(record, dict) else None
    return line if isinstance(line, int) else None


def _digest(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()


def _span(index, field, start, end, text, record):
    return Span(index=index, field=field, start=start, end=end,
                sha256=_digest(text), line=_line(record))


def _content_parts(content, root='payload.content'):
    """([(field path, exact text)], opaque) rooted at ``root``."""
    if isinstance(content, str):
        return [(root, content)], False
    if isinstance(content, dict):
        if content.get('encrypted_content') is not None:
            return [], True
        value = content.get('text')
        return ([(root + '.text', value)] if isinstance(value, str) else []), False
    if not isinstance(content, list):
        return [], False
    parts, opaque = [], False
    for position, item in enumerate(content):
        item_root = f'{root}[{position}]'
        if isinstance(item, str):
            parts.append((item_root, item))
        elif not isinstance(item, dict):
            continue
        elif item.get('encrypted_content') is not None or item.get('type') in _OPAQUE_TYPES:
            opaque = True
        elif isinstance(item.get('text'), str):
            parts.append((item_root + '.text', item['text']))
        elif isinstance(item.get('content'), str):
            parts.append((item_root + '.content', item['content']))
    return parts, opaque



def _rendered(parts):
    return '\n'.join(text for _, text in parts)


def _content_span(index, base, parts, record):
    """(text, span): exact for one field, a labelled rendering for several."""
    text = _rendered(parts)
    if len(parts) == 1:
        return text, Span(index=index, field=parts[0][0], start=0, end=len(text),
                          sha256=_digest(text), line=_line(record))
    return text, Span(index=index, field=base, start=None, end=None,
                      sha256=_digest(text), line=_line(record), derived=True,
                      sources=tuple(field for field, _ in parts))


def _call_body(payload):
    """(field, body) using input or arguments. Body is never truncated."""
    for field in ('input', 'arguments'):
        value = payload.get(field)
        if isinstance(value, str) and value.strip():
            return field, value
        if isinstance(value, dict):
            return field, json.dumps(value, sort_keys=True, separators=(',', ':'))
    return ('input' if 'input' in payload else 'arguments', '')


def _decoded_args(body):
    try:
        value = json.loads(body)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _is_compacted(record):
    """The real record keeps the type on the record; accept either placement."""
    return isinstance(record, dict) and (
        record.get('type') == 'compacted' or _payload(record).get('type') == 'compacted')


def _output_text(payload):
    raw = payload.get('output')
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list):
        parts = []
        for item in raw:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get('text'), str):
                parts.append(item['text'])
        return '\n'.join(parts)
    return ''


def _announcements(text):
    """Handles announced by a recognized harness wrapper; () when unrecognized."""
    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    if not lines:
        return ()
    first = lines[0]
    found = []
    running = _WRAPPER_RUNNING.match(first)
    if running:
        found.append(('cell_id', running.group(1)))
    elif not _WRAPPER_FINISHED.match(first):
        return ()   # unknown wrapper: no announcements, never a guess
    for line in lines[:8]:
        if _ENVELOPE_LINE.match(line):
            match = _ENVELOPE_SESSION.search(line)
            if match:
                found.append(('session_id', match.group(1)))
            break
    return tuple(found)


def _announcement_index(records, upto):
    """(namespace, handle) -> [(record index of producing call, payload)] prior to upto."""
    index, calls = {}, {}
    for i in range(min(upto, len(records))):
        payload = _payload(records[i])
        kind = payload.get('type')
        if kind in CALL_TYPES:
            calls[payload.get('call_id')] = i
        elif kind in OUTPUT_TYPES:
            owner = calls.get(payload.get('call_id'))
            if owner is None:
                continue
            producer = _payload(records[owner])
            name = producer.get('name')
            for namespace, handle in _announcements(_output_text(payload)):
                if ANNOUNCERS.get(namespace) != name:
                    continue
                index.setdefault((namespace, handle), []).append((owner, producer))
    return index


def _single_element(text, name, opening):
    """True when the whole message is one ``<name>...</name>`` element."""
    closing = f'</{name}>'
    return text == opening or (text.endswith(closing) and text.count(closing) == 1)


def _classify_message(role, text, opaque):
    """(provenance, refusal reason). Only readable ``user`` turns become 'human'."""
    if opaque:
        return None, 'opaque_instruction'
    stripped = text.strip()
    if not stripped:
        return None, 'empty_instruction'
    if role == 'developer':
        return None, 'developer_role'
    if role != 'user':
        return None, None
    if stripped.startswith(DOC_ENVELOPE_PREFIX):
        return None, 'harness_envelope'
    tag = _TAG.match(stripped)
    if tag:
        name = tag.group(1).lower()
        if name in KNOWN_ENVELOPE_TAGS:
            return None, 'harness_envelope'
        if _single_element(stripped, name, tag.group(0)):
            return None, 'unknown_wrapper'
    return HUMAN, None


def _order_key(pair):
    order = pair[0]
    if isinstance(order, bool):
        return (2, str(order))
    if isinstance(order, int):
        return (0, order)
    return (1, str(order))


def _compacted_instructions(record, index):
    """[(order, Instruction)] from compacted history with explicit provenance."""
    payload = _payload(record)
    history = payload.get('replacement_history')
    metadata = payload.get('replacement_history_metadata')
    if not isinstance(history, list) or not isinstance(metadata, list):
        return []
    if len(history) != len(metadata):
        return []
    found = []
    for position, item in enumerate(history):
        meta = metadata[position]
        if not isinstance(meta, dict) or not isinstance(item, dict):
            continue
        if meta.get('client_authored') is not True or not meta.get('retained_source'):
            continue
        order = meta.get('user_input_order')
        if isinstance(order, bool) or not isinstance(order, (int, str)):
            continue
        if item.get('role') != 'user':
            continue
        base = f'payload.replacement_history[{position}].content'
        parts, opaque = _content_parts(item.get('content'), root=base)
        if opaque or not _rendered(parts).strip():
            continue
        text, span = _content_span(index, base, parts, record)
        if _classify_message('user', text, False)[0] is None:
            continue
        found.append((order, Instruction(COMPACTED_HUMAN, text, span)))
    return found


def _scan(records):
    """(instructions, refusal tally, first compaction index, last one verified)."""
    ordered, tally = [], {}
    compacted_at, last_verified = None, False
    for index, record in enumerate(records):
        if _is_compacted(record):
            if compacted_at is None:
                compacted_at = index
            entries = _compacted_instructions(record, index)
            last_verified = bool(entries)
            ordered.extend(instr for _, instr in sorted(entries, key=_order_key))
            continue
        payload = _payload(record)
        if payload.get('type') != 'message':
            continue
        role = payload.get('role')
        if role not in ('user', 'developer'):
            continue
        parts, opaque = _content_parts(payload.get('content'))
        text = _rendered(parts)
        provenance, reason = _classify_message(role, text, opaque)
        if reason:
            entry = tally.setdefault(reason, [0, index, _line(record)])
            entry[0] += 1
        if provenance is None:
            continue
        text, span = _content_span(index, 'payload.content', parts, record)
        ordered.append(Instruction(provenance, text, span))
    return ordered, tally, compacted_at, last_verified


def _goal(records):
    """(Goal, compacted) from the records in scope."""
    ordered, tally, compacted_at, verified = _scan(records)
    compacted = compacted_at is not None

    if compacted and not verified:
        # The pre-compaction goal is unknown. Later requests stay visible but
        # are never promoted to stand in for it.
        return Goal(AMBIGUOUS, None, 'compacted_history', tuple(ordered)), True
    if ordered:
        return Goal(AVAILABLE, ordered[-1], None, tuple(ordered)), compacted
    if tally.get('unknown_wrapper'):
        return Goal(AMBIGUOUS, None, 'unknown_wrapper'), compacted
    if tally.get('opaque_instruction'):
        return Goal(MISSING, None, 'opaque_instruction'), compacted
    if tally:
        return Goal(MISSING, None, 'no_human_instruction'), compacted
    return Goal(MISSING, None, 'no_records' if not records else 'no_user_message'), compacted


def _origin(records, call_index, call_id):
    if call_index is None:
        return Origin(MISSING, None, None, None, None, 'call_not_found')
    payload = _payload(records[call_index])
    name = payload.get('name')
    field, body = _call_body(payload)
    handle_key = POLL_HANDLES.get(name)

    if handle_key:
        # Poll semantics come from the call name; the body is never a command.
        args = _decoded_args(body)
        if not isinstance(args, dict):
            return Origin(MISSING, name, None, None, None, 'unrecognized_poll_body')
        raw = args.get(handle_key)
        if isinstance(raw, bool) or not isinstance(raw, (str, int)) or not str(raw).strip():
            return Origin(MISSING, name, None, None, None, 'poll_without_handle')
        handle = str(raw).strip()
        hits = _announcement_index(records, call_index).get((handle_key, handle), [])
        if not hits:
            return Origin(MISSING, name, None, None, None, f'unresolved_{handle_key}')
        owner, producer = hits[-1]   # nearest prior announcement
        owner_field, owner_body = _call_body(producer)
        if not owner_body.strip():
            return Origin(MISSING, producer.get('name'), None, None, None, 'producer_body_empty')
        via = (f'{handle_key}={handle} -> {producer.get("name")} '
               f'call_id={producer.get("call_id")} line={_line(records[owner])}')
        return Origin(AVAILABLE, producer.get('name'), owner_body,
                      _span(owner, f'payload.{owner_field}', 0, len(owner_body),
                            owner_body, records[owner]),
                      via, None)

    if body.strip():
        return Origin(AVAILABLE, name, body,
                      _span(call_index, f'payload.{field}', 0, len(body), body,
                            records[call_index]),
                      None, None)
    return Origin(MISSING, name, None, None, None, 'empty_call_body')


def context_for(records, call_id, *, before=None):
    """Causal context for ``call_id``'s result, from records strictly before it.

    ``records`` is an ordered sequence of rollout record mappings. The caller may
    pass only pre-checkpoint records, or pass everything with ``before=n`` to
    bound the sequence (exclusive). Records at or after the target call's own
    output are never used, so a later message cannot stand in for an earlier one.
    """
    rows = list(records)
    if before is not None:
        if not isinstance(before, int) or isinstance(before, bool) or before < 0:
            raise ValueError('before must be a non-negative int')
        rows = rows[:before]

    target = next(
        (i for i, record in enumerate(rows)
         if _payload(record).get('call_id') == call_id
         and _payload(record).get('type') in CALL_TYPES),
        None,
    )
    end = len(rows)
    if target is not None:
        for i in range(target + 1, len(rows)):
            payload = _payload(rows[i])
            if payload.get('call_id') == call_id and payload.get('type') in OUTPUT_TYPES:
                end = i
                break
    scope = rows[:end]

    goal, compacted = _goal(scope)
    origin = _origin(scope, target, call_id)
    exclusions = tuple(
        Exclusion(reason=reason, count=count, first_index=index, first_line=line)
        for reason, (count, index, line) in sorted(exclusions_of(scope).items(),
                                                   key=lambda item: (-item[1][0], item[0]))
        if reason not in AMBIGUOUS_REASONS
    )
    return Context(call_id=call_id, goal=goal, origin=origin, considered=len(scope),
                   exclusions=exclusions, compacted=compacted)


def exclusions_of(records):
    """Reason -> [count, first index, first line] for refused instruction candidates."""
    return _scan(records)[1]
