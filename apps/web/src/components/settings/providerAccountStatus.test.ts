import { describe, expect, it } from "vite-plus/test";

import { limitedUntilLabel } from "./providerAccountStatus";

describe("limitedUntilLabel", () => {
  const nowMs = Date.parse("2026-10-19T12:00:00.000Z");
  it("is absent without a future limit", () => {
    expect(limitedUntilLabel({}, nowMs, "locale")).toBeNull();
    expect(
      limitedUntilLabel({ limitedUntil: "2026-10-19T11:00:00.000Z" }, nowMs, "locale"),
    ).toBeNull();
  });

  it("names the time the account is available again", () => {
    expect(
      limitedUntilLabel({ limitedUntil: "2026-10-19T12:30:00.000Z" }, nowMs, "locale"),
    ).toMatch(/^Limited until /);
  });
});
