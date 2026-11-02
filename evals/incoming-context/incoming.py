"""Apply a decision to a new result without touching serialized prior messages."""
import copy
import hashlib
import json
import re


_JSON_WS = re.compile(r'[ \t\r\n]*')


def _output_span(value):
    """Locate the effective output value in an already validated JSON object."""
    decoder = json.JSONDecoder()
    pos = _JSON_WS.match(value, value.index('{') + 1).end()
    span = None
    while value[pos] != '}':
        key, pos = decoder.raw_decode(value, pos)
        colon = _JSON_WS.match(value, pos).end()
        start = _JSON_WS.match(value, colon + 1).end()
        _, end = decoder.raw_decode(value, start)
        if key == 'output':
            span = (start, end)
        pos = _JSON_WS.match(value, end).end()
        if value[pos] == ',':
            pos = _JSON_WS.match(value, pos + 1).end()
    return span


def stamp(prefix: bytes) -> str:
    return hashlib.sha256(prefix).hexdigest()


def envelope_digest(item: dict) -> str:
    """Everything about the incoming item except the text being replaced."""
    return hashlib.sha256(json.dumps({k: v for k, v in item.items() if k != 'output'},
                                     sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def apply_incoming(prefix: bytes, incoming: dict, replacement_output):
    if incoming.get('type') not in ('function_call_output', 'custom_tool_call_output'):
        raise ValueError('Only incoming tool results may be changed')
    if 'call_id' not in incoming or 'output' not in incoming:
        raise ValueError('A complete incoming tool result is required')
    original_hash = stamp(prefix)
    envelope_before = envelope_digest(incoming)
    selected = copy.deepcopy(incoming)
    selected['output'] = replacement_output
    if selected['call_id'] != incoming['call_id']:
        raise AssertionError('Tool linkage changed')
    if envelope_digest(selected) != envelope_before:
        raise AssertionError('Envelope fields other than output changed')
    assert stamp(prefix) == original_hash
    # The integration must append this new item, not reserialize the prefix.
    return prefix, selected, {'prefix_sha256': original_hash,
                              'prefix_sha256_after': stamp(prefix),
                              'envelope_sha256_before': envelope_before,
                              'envelope_sha256_after': envelope_digest(selected),
                              'old_prefix_changed': False}


def text_leaves(value):
    """Locate strings, including output inside an incoming JSON tool envelope."""
    if isinstance(value, str):
        try:
            obj = json.loads(value)
        except (ValueError, TypeError):
            return [([], value)]
        if isinstance(obj, dict) and isinstance(obj.get('output'), str):
            return [(['json', 'output'], obj['output'])]
        return [([], value)]
    if isinstance(value, list):
        leaves = []
        for i, block in enumerate(value):
            if isinstance(block, dict) and block.get('type') in ('input_text', 'text') and isinstance(block.get('text'), str):
                leaves.extend(([i, 'text'] + path, text) for path, text in text_leaves(block['text']))
        return leaves
    return []


def replace_leaf(value, path, replacement):
    if not isinstance(replacement, str):
        raise ValueError('Only text replacements are supported')
    if not path:
        if not isinstance(value, str):
            raise ValueError('Only text leaves may be changed')
        return replacement
    selected = copy.deepcopy(value)
    key, *rest = path
    if key == 'json':
        obj = json.loads(value)
        if rest != ['output'] or not isinstance(obj, dict) or not isinstance(obj.get('output'), str):
            raise ValueError('Only the text output of a JSON tool envelope may be changed')
        start, end = _output_span(value)
        # Re-encoding the object can discard duplicate fields and alter diagnostic metadata.
        return value[:start] + json.dumps(replacement, ensure_ascii=False) + value[end:]
    selected[key] = replace_leaf(selected[key], rest, replacement)
    return selected
