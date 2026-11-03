import math

PROMPT = (
    'Could the agent handle the new user message independently of all earlier thread '
    'context, without reusing any earlier result, file, decision, or instruction? '
    'Answer yes only if independent.'
)


def request(state):
    return {
        'state': state,
        'questions': {'q': {
            'type': 'noul',
            'instructions': PROMPT,
            'criteria': {
                'true': 'No earlier thread result, file, decision, or instruction is needed.',
                'false': 'Handling relies on an earlier thread result, file, decision, or instruction.',
            },
        }},
    }


def score_response(response):
    if response.truncated:
        return None
    score = float(response.answers['q'].noul)
    if not math.isfinite(score) or not 0 <= score <= 1:
        raise ValueError('Invalid independence score')
    return score


def summarize(rows, threshold):
    if not math.isfinite(threshold) or not 0 <= threshold <= 1:
        raise ValueError('Threshold must be between zero and one')
    counts = dict(tp=0, fp=0, tn=0, fn=0, abstained=0)
    seen = set()
    for row in rows:
        if row['id'] in seen:
            raise ValueError('Duplicate case id')
        seen.add(row['id'])
        if row['label'] not in ('INDEPENDENT', 'DEPENDS'):
            raise ValueError('Unknown label')
        score = row['score']
        if score is None:
            counts['abstained'] += 1
            continue
        if not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError('Invalid independence score')
        positive = row['label'] == 'INDEPENDENT'
        predicted = score >= threshold
        counts[('t' if positive == predicted else 'f') + ('p' if predicted else 'n')] += 1
    return counts
