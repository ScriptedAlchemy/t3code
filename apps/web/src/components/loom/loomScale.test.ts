import type { LoomWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fitLoomView, loomScale } from "./loomScale";

const HOUR = 3_600_000;
const FROM = Date.parse("2026-10-22T12:00:00.000Z");
const TO = FROM + 24 * HOUR;
const bounds = { fromMs: FROM, toMs: TO };
const iso = (ms: number) => new Date(ms).toISOString();

function loomWindow(patch: Partial<LoomWindow>): LoomWindow {
  return {
    projectId: "project-1",
    asOf: iso(TO),
    from: iso(FROM),
    to: iso(TO),
    lanes: [],
    ancestors: [],
    runs: [],
    markers: [],
    edges: [],
    activity: [],
    truncated: {
      lanes: false,
      ancestors: false,
      runs: false,
      markers: false,
      edges: false,
      activity: false,
      bytes: false,
    },
    coverage: { lanes: true },
    ...patch,
  } as LoomWindow;
}

describe("loomScale", () => {
  it("keeps events at either end of the view inside the drawable width", () => {
    const scale = loomScale(bounds, 600);
    expect(scale.x(FROM)).toBeGreaterThanOrEqual(6);
    expect(scale.x(TO)).toBeLessThanOrEqual(594);
    expect(scale.ms(scale.x(FROM + HOUR))).toBeCloseTo(FROM + HOUR);
  });
});

describe("fitLoomView", () => {
  it("frames the window's activity instead of the whole window", () => {
    const start = TO - 5 * 60_000;
    const end = TO - 2 * 60_000;
    const view = fitLoomView(
      loomWindow({
        runs: [
          {
            requestedAt: iso(start),
            startedAt: iso(start + 1_000),
            completedAt: iso(end),
          } as LoomWindow["runs"][number],
        ],
      }),
      bounds,
    );
    expect(view.fromMs).toBeLessThanOrEqual(start);
    expect(view.toMs).toBeGreaterThanOrEqual(end);
    expect(view.toMs - view.fromMs).toBeLessThan(HOUR);
    expect(view.toMs).toBeLessThanOrEqual(TO);
  });

  it("shows the whole window when nothing happened in it", () => {
    expect(fitLoomView(loomWindow({}), bounds)).toEqual(bounds);
  });

  it.each(["completed", "failed", "interrupted", "cancelled", "rolled_back"] as const)(
    "fits recorded activity for a %s run without a completion time",
    (status) => {
      const start = FROM + HOUR;
      const view = fitLoomView(
        loomWindow({
          runs: [
            {
              status,
              requestedAt: iso(start),
              startedAt: iso(start + 1_000),
              completedAt: null,
            } as LoomWindow["runs"][number],
          ],
        }),
        bounds,
      );
      expect(view.fromMs).toBeLessThanOrEqual(start);
      expect(view.toMs).toBeGreaterThanOrEqual(start + 1_000);
      expect(view.toMs - view.fromMs).toBeLessThan(HOUR);
    },
  );

  it("fits through the as-of time for a run that is still active", () => {
    const start = FROM + HOUR;
    const view = fitLoomView(
      loomWindow({
        runs: [
          {
            status: "running",
            requestedAt: iso(start),
            startedAt: iso(start + 1_000),
            completedAt: null,
          } as LoomWindow["runs"][number],
        ],
      }),
      bounds,
    );
    expect(view.fromMs).toBeLessThanOrEqual(start);
    expect(view.toMs).toBe(TO);
  });
});
