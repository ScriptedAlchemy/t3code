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

export function loomScale(view: LoomView, width: number) {
  const span = Math.max(view.toMs - view.fromMs, 1);
  return {
    x: (ms: number) => ((ms - view.fromMs) / span) * width,
    ms: (x: number) => view.fromMs + (x / width) * span,
  };
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
