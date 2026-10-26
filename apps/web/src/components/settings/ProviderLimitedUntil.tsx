import type { ServerProvider } from "@t3tools/contracts";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { limitedUntilLabel } from "./ProviderPoolsSettings.logic";

/**
 * The server publishes `limitedUntil` once and never again when it passes, so this reads the
 * clock itself and drops the label when the account is usable again.
 */
export function ProviderLimitedUntil({
  provider,
  className,
}: {
  readonly provider: Pick<ServerProvider, "limitedUntil"> | undefined;
  readonly className?: string;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const label = provider ? limitedUntilLabel(provider, nowMs, timestampFormat) : null;
  return label === null ? null : <span className={className}>{label}</span>;
}
