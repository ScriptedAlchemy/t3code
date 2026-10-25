import type { LoomWindow } from "@t3tools/contracts";

export interface LoomView {
  readonly fromMs: number;
  readonly toMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LOOM_MIN_VIEW_MS = 5 * MINUTE;

const TICK_STEPS = [
  MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
];

// Glyphs extend a few pixels around their time, so an event at either end of the view would be
// half clipped by the SVG without this inset.
const LOOM_EDGE_INSET = 8;

export function loomScale(view: LoomView, width: number) {
  const span = Math.max(view.toMs - view.fromMs, 1);
  const inner = Math.max(width - 2 * LOOM_EDGE_INSET, 1);
  return {
    x: (ms: number) => LOOM_EDGE_INSET + ((ms - view.fromMs) / span) * inner,
    ms: (x: number) => view.fromMs + ((x - LOOM_EDGE_INSET) / inner) * span,
    msPerPx: span / inner,
  };
}

/** Frames the window's activity with a margin, or the whole window when nothing happened. */
export function fitLoomView(window: LoomWindow, bounds: LoomView): LoomView {
  const times = [
    ...window.runs.flatMap((run) => [
      run.requestedAt,
      run.startedAt,
      run.completedAt ?? window.asOf,
    ]),
    ...window.markers.flatMap((marker) => [
      marker.at,
      "completedAt" in marker ? marker.completedAt : null,
    ]),
    ...window.edges.map((edge) => edge.at),
  ]
    .flatMap((iso) => (iso === null ? [] : [Date.parse(iso)]))
    .filter((ms) => ms >= bounds.fromMs && ms <= bounds.toMs);
  if (times.length === 0) return bounds;
  const first = Math.min(...times);
  const last = Math.max(...times);
  const span = Math.min(
    Math.max((last - first) * 1.1, LOOM_MIN_VIEW_MS),
    bounds.toMs - bounds.fromMs,
  );
  const center = (first + last) / 2;
  return clampLoomView({ fromMs: center - span / 2, toMs: center + span / 2 }, bounds);
}

/** Evenly stepped ticks aligned to local time, at most one per `minGapPx`. */
export function loomTicks(view: LoomView, width: number, minGapPx = 96): ReadonlyArray<number> {
  const span = view.toMs - view.fromMs;
  const maxTicks = Math.max(1, Math.floor(width / minGapPx));
  const step = TICK_STEPS.find((candidate) => span / candidate <= maxTicks) ?? 28 * DAY;
  const offset = new Date(view.fromMs).getTimezoneOffset() * MINUTE;
  const first = Math.ceil((view.fromMs - offset) / step) * step + offset;
  const ticks: Array<number> = [];
  for (let tick = first; tick <= view.toMs; tick += step) ticks.push(tick);
  return ticks;
}

export function formatLoomTick(ms: number, view: LoomView): string {
  const date = new Date(ms);
  const span = view.toMs - view.fromMs;
  if (span > 2 * DAY) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric" });
  }
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatLoomTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Zooms around `anchorMs`, never past the window or below LOOM_MIN_VIEW_MS. */
export function zoomLoomView(
  view: LoomView,
  bounds: LoomView,
  anchorMs: number,
  factor: number,
): LoomView {
  const span = Math.min(
    Math.max((view.toMs - view.fromMs) * factor, LOOM_MIN_VIEW_MS),
    bounds.toMs - bounds.fromMs,
  );
  const ratio = (anchorMs - view.fromMs) / (view.toMs - view.fromMs);
  return clampLoomView(
    { fromMs: anchorMs - span * ratio, toMs: anchorMs + span * (1 - ratio) },
    bounds,
  );
}

export function panLoomView(view: LoomView, bounds: LoomView, deltaMs: number): LoomView {
  return clampLoomView({ fromMs: view.fromMs + deltaMs, toMs: view.toMs + deltaMs }, bounds);
}

function clampLoomView(view: LoomView, bounds: LoomView): LoomView {
  const span = view.toMs - view.fromMs;
  if (view.fromMs < bounds.fromMs) return { fromMs: bounds.fromMs, toMs: bounds.fromMs + span };
  if (view.toMs > bounds.toMs) return { fromMs: bounds.toMs - span, toMs: bounds.toMs };
  return view;
}
