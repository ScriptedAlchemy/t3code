import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";

export const LanTlsTrust = Schema.Struct({
  environmentId: EnvironmentId,
  certificateAuthority: Schema.String.check(
    Schema.isPattern(
      /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]{1,8192}-----END CERTIFICATE-----\s*$/,
    ),
  ),
});
export type LanTlsTrust = typeof LanTlsTrust.Type;
