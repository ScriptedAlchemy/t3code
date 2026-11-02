"""Summarize and chart local decision-model evaluation results. Local artifacts only."""
import argparse
import html
import json
from pathlib import Path


def load(paths):
    runs = []
    for p in paths:
        d = json.loads(Path(p).read_text())
        d['file'] = str(p)
        runs.append(d)
    return runs


def name_of(run):
    if run['policy'] != 'decision':
        return run['policy']
    model = (run.get('model') or 'model').split('/')[-1]
    return f"{model} / {run.get('batch_mode')} @ {run.get('threshold')}"


def summarize(runs):
    rows = []
    for r in runs:
        t = r['totals']
        rows.append({
            'name': name_of(r), 'file': r['file'], 'cases': t['cases'], 'sessions': t['sessions'],
            'blocks': t['blocks'], 'protected': t['protected_blocks'], 'scored': t['scored_blocks'],
            'dropped': t['dropped_blocks'], 'before': t['before'], 'after': t['after'],
            'saved_fraction': t['saved_fraction'],
            'case_p50': t['case_latency_ms']['p50'], 'case_p95': t['case_latency_ms']['p95'],
            'case_p99': t['case_latency_ms']['p99'], 'case_max': t['case_latency_ms']['max'],
            'block_p50': t['block_latency_ms']['p50'], 'block_p95': t['block_latency_ms']['p95'],
            'completed_requests': t['completed_requests'], 'failed_requests': t['failed_requests'],
            'deadline_cases': t['deadline_abstained_cases'],
            'histogram': t['score_histogram'],
        })
    return rows


def markdown(rows):
    out = ['| configuration | cases | blocks | scored | dropped | saved | case p50 ms | p95 ms | p99 ms | max ms | failed | deadline |',
           '|---|---|---|---|---|---|---|---|---|---|---|---|']
    for r in rows:
        saved = 'n/a' if r['saved_fraction'] is None else f"{r['saved_fraction'] * 100:.1f}%"
        out.append(f"| {r['name']} | {r['cases']} | {r['blocks']} | {r['scored']} | {r['dropped']} | {saved} | "
                   f"{r['case_p50']} | {r['case_p95']} | {r['case_p99']} | {r['case_max']} | {r['failed_requests']} | {r['deadline_cases']} |")
    return '\n'.join(out)


def bars(series, width=560, bar=18, pad=8, colors=None):
    peak = max((v or 0) for _, v in series) or 1
    height = len(series) * (bar + pad) + 10
    parts = [f'<svg viewBox="0 0 {width} {height}" width="100%" role="img">']
    for i, (label, value) in enumerate(series):
        y = 6 + i * (bar + pad)
        w = 0 if not value else max(1, int((value / peak) * (width - 260)))
        parts.append(f'<text x="0" y="{y + 13}" font-size="12" fill="#333">{html.escape(label)}</text>')
        parts.append(f'<rect x="180" y="{y}" width="{w}" height="{bar}" fill="#4b7bec" rx="2"/>')
        shown = 'n/a' if value is None else f'{value:.3f}'
        parts.append(f'<text x="{186 + w}" y="{y + 13}" font-size="11" fill="#333">{shown}</text>')
    parts.append('</svg>')
    return ''.join(parts)


def scatter(rows, width=640, height=260):
    points = []
    for r in rows:
        cases = json.loads(Path(r['file']).read_text())['cases']
        points.extend((r['name'], c['before'], c['latency_ms']) for c in cases if c['before'])
    if not points:
        return '<p>No case points.</p>'
    max_x = max(p[1] for p in points)
    max_y = max(p[2] for p in points)
    colors = ['#4b7bec', '#eb3b5a', '#20bf6b', '#fa8231', '#8854d0', '#3867d6']
    names = sorted({p[0] for p in points})
    parts = [f'<svg viewBox="0 0 {width} {height}" width="100%" role="img">',
             f'<line x1="40" y1="{height - 30}" x2="{width - 10}" y2="{height - 30}" stroke="#bbb"/>',
             f'<line x1="40" y1="10" x2="40" y2="{height - 30}" stroke="#bbb"/>']
    for name, x, y in points:
        px = 40 + (x / max_x) * (width - 60)
        py = height - 30 - (y / max_y) * (height - 45)
        parts.append(f'<circle cx="{px:.0f}" cy="{py:.0f}" r="3" fill="{colors[names.index(name) % len(colors)]}" opacity="0.7"/>')
    parts.append(f'<text x="{width - 120}" y="{height - 12}" font-size="11" fill="#555">result tokens →</text>')
    parts.append(f'<text x="0" y="18" font-size="11" fill="#555">ms ↑</text>')
    parts.append('</svg>')
    legend = ' '.join(f'<span style="color:{colors[i % len(colors)]}">●</span> {html.escape(n)}'
                      for i, n in enumerate(names))
    return f'<p>{legend}</p>' + ''.join(parts)


def threshold_curves(payload, width=640, height=280):
    series = {name: [(r['threshold'], r['saved_fraction'] or 0) for r in info['curve']]
              for name, info in payload['candidates'].items()}
    if not series:
        return '<p>No threshold curves.</p>'
    xs = [t for points in series.values() for t, _ in points]
    ys = [v for points in series.values() for _, v in points]
    min_x, max_x = min(xs), max(xs)
    max_y = max(ys) or 1
    colors = ['#4b7bec', '#eb3b5a', '#20bf6b', '#fa8231', '#8854d0']
    parts = [f'<svg viewBox="0 0 {width} {height}" width="100%" role="img">',
             f'<line x1="48" y1="{height - 34}" x2="{width - 10}" y2="{height - 34}" stroke="#bbb"/>',
             f'<line x1="48" y1="10" x2="48" y2="{height - 34}" stroke="#bbb"/>']
    for i, (name, points) in enumerate(sorted(series.items())):
        coords = ' '.join(f"{48 + (t - min_x) / (max_x - min_x) * (width - 60):.0f},"
                          f"{height - 34 - (v / max_y) * (height - 52):.0f}" for t, v in points)
        parts.append(f'<polyline points="{coords}" fill="none" stroke="{colors[i % len(colors)]}" stroke-width="2"/>')
    parts.append(f'<text x="48" y="{height - 16}" font-size="11" fill="#555">threshold {min_x:.2f} to {max_x:.2f}</text>')
    parts.append(f'<text x="0" y="18" font-size="11" fill="#555">saved ↑</text>')
    parts.append('</svg>')
    legend = ' '.join(f'<span style="color:{colors[i % len(colors)]}">—</span> {html.escape(n)}'
                      for i, n in enumerate(sorted(series)))
    return f'<p>{legend}</p>' + ''.join(parts)


def report(runs, out_json=None, out_html=None, curves=None):
    rows = summarize(runs)
    print(markdown(rows))
    for r in rows:
        print(f"\n{r['name']} score buckets: " + json.dumps(r['histogram']))
    if out_json:
        Path(out_json).write_text(json.dumps({'rows': rows}, indent=2))
    if out_html:
        parts = ['<!doctype html><meta charset="utf-8"><title>Local incoming-pruning evaluation</title>',
                 '<style>body{font-family:ui-sans-serif,system-ui;margin:32px;max-width:900px;color:#222}'
                 'h2{margin-top:32px}table{border-collapse:collapse;font-size:13px}'
                 'td,th{border-bottom:1px solid #ddd;padding:4px 8px;text-align:right}'
                 'th:first-child,td:first-child{text-align:left}</style>',
                 '<h1>Local decision-model evaluation</h1>',
                 '<p>Incoming tool-output pruning, development cases only. Quality is unvalidated '
                 'without blind judgments; no labels exist for these cases.</p>',
                 '<h2>Token savings</h2>',
                 bars([(r['name'], r['saved_fraction']) for r in rows]),
                 '<h2>Case latency p50 / p95 / p99 (ms)</h2>',
                 bars([(r['name'] + ' p50', r['case_p50']) for r in rows]),
                 bars([(r['name'] + ' p95', r['case_p95']) for r in rows]),
                 bars([(r['name'] + ' p99', r['case_p99']) for r in rows]),
                 '<h2>Case tokens vs measured latency</h2>', scatter(rows),
                 '<h2>Per-block keep score buckets</h2>']
        seen = set()
        for r in rows:
            model = r['name'].split(' @ ')[0]
            if model in seen:
                continue
            seen.add(model)
            parts.append(f'<h3>{html.escape(r["name"])}</h3>')
            parts.append(bars([(k, v) for k, v in r['histogram'].items()]))
        if curves:
            parts.append('<h2>Saved fraction vs. threshold (development cases)</h2>')
            parts.append(threshold_curves(json.loads(Path(curves).read_text())))
        parts.append('<h2>Table</h2><table><tr>' + ''.join(
            f'<th>{h}</th>' for h in ('configuration', 'cases', 'blocks', 'scored', 'dropped',
                                      'saved', 'p50 ms', 'p95 ms', 'p99 ms', 'failed')) + '</tr>')
        for r in rows:
            saved = 'n/a' if r['saved_fraction'] is None else f"{r['saved_fraction'] * 100:.1f}%"
            parts.append('<tr>' + ''.join(
                f'<td>{html.escape(str(v))}</td>' for v in
                (r['name'], r['cases'], r['blocks'], r['scored'], r['dropped'], saved,
                 r['case_p50'], r['case_p95'], r['case_p99'], r['failed_requests'])) + '</tr>')
        parts.append('</table>')
        Path(out_html).write_text('\n'.join(parts))
    return rows


def main():
    p = argparse.ArgumentParser()
    p.add_argument('results', nargs='+')
    p.add_argument('--json')
    p.add_argument('--html')
    p.add_argument('--curves')
    a = p.parse_args()
    report(load(a.results), a.json, a.html, a.curves)


if __name__ == '__main__':
    main()
