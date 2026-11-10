import type { ServerProvider } from "./server.ts";

export function providerLimitedUntilMs(
  provider: Pick<ServerProvider, "limitedUntil">,
  nowMs: number,
): number | null {
  if (provider.limitedUntil === undefined) return null;
  const untilMs = Date.parse(provider.limitedUntil);
  return untilMs > nowMs ? untilMs : null;
}
