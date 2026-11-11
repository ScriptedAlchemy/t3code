import { describe, expect, it } from "vite-plus/test";
import { providerLimitedUntilMs } from "./providerLimits.ts";

describe("providerLimitedUntilMs", () => {
  const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

  it("reports a future cooldown and drops a past, absent, or unreadable one", () => {
    expect(providerLimitedUntilMs({ limitedUntil: "2026-10-19T12:15:00.000Z" }, nowMs)).toBe(
      nowMs + 15 * 60_000,
    );
    expect(providerLimitedUntilMs({ limitedUntil: "2026-10-19T12:00:00.000Z" }, nowMs)).toBeNull();
    expect(providerLimitedUntilMs({}, nowMs)).toBeNull();
    expect(providerLimitedUntilMs({ limitedUntil: "soon" }, nowMs)).toBeNull();
  });
});
