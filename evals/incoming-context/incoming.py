"""Apply a decision to a new result without touching serialized prior messages."""
import copy
import hashlib
import json


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
    if not path:
        if not isinstance(value, str):
            raise ValueError('Only text leaves may be changed')
        return replacement
    selected = copy.deepcopy(value)
    key, *rest = path
    if key == 'json':
        obj = json.loads(value)
        obj = replace_leaf(obj, rest, replacement)
        return json.dumps(obj, ensure_ascii=False)
    selected[key] = replace_leaf(selected[key], rest, replacement)
    return selected
