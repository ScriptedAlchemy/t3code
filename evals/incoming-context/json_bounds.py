"""Bound container nesting independently of the JSON decoder."""

MAX_JSON_DEPTH = 64


def exceeds_depth(raw, start):
    stack = []
    quoted = False
    escaped = False
    for i in range(start, len(raw)):
        ch = raw[i]
        if quoted:
            if escaped:
                escaped = False
            elif ch == '\\':
                escaped = True
            elif ch == '"':
                quoted = False
        elif ch == '"':
            quoted = True
        elif ch in '[{':
            stack.append(ch)
            if len(stack) > MAX_JSON_DEPTH:
                return True
        elif ch in ']}':
            if not stack or stack[-1] != ('[' if ch == ']' else '{'):
                return False
            stack.pop()
            if not stack:
                return False
    return False
