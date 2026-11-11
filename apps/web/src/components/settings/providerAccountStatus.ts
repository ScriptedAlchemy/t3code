import { providerLimitedUntilMs, type ServerProvider } from "@t3tools/contracts";

import type { TimestampFormat } from "@t3tools/contracts/settings";

import { formatUpcomingTimestamp } from "../../timestampFormat";

export function limitedUntilLabel(
  provider: Pick<ServerProvider, "limitedUntil">,
  nowMs: number,
  timestampFormat: TimestampFormat,
): string | null {
  if (provider.limitedUntil === undefined || providerLimitedUntilMs(provider, nowMs) === null) {
    return null;
  }
  return `Limited until ${formatUpcomingTimestamp(provider.limitedUntil, timestampFormat, nowMs)}`;
}
