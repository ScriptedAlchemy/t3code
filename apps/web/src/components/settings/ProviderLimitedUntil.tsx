import type { ServerProvider } from "@t3tools/contracts";

import { useClientSettings } from "../../hooks/useSettings";
import { limitedUntilLabel } from "./ProviderPoolsSettings.logic";
import { useRelativeTimeTick } from "./settingsLayout";

const LIMIT_EXPIRY_CHECK_MS = 30_000;

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
  const nowMs = useRelativeTimeTick(LIMIT_EXPIRY_CHECK_MS);
  const label = provider ? limitedUntilLabel(provider, nowMs, timestampFormat) : null;
  return label === null ? null : <span className={className}>{label}</span>;
}
