import type { EnvironmentId, LanTlsTrust } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ClientCapabilities from "../platform/capabilities.ts";
import type { ConnectionRoute } from "./catalog.ts";
import { ConnectionBlockedError } from "./model.ts";

export const acquireLanTls = Effect.fn("connection.acquireLanTls")(function* (input: {
  readonly httpBaseUrl: string;
  readonly environmentId: EnvironmentId;
  readonly tls?: LanTlsTrust;
  readonly wsBaseUrl?: string;
}) {
  if (input.tls === undefined) return;
  if (input.tls.environmentId !== input.environmentId) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail:
        "The LAN certificate identity belongs to a different environment. Pair again with its full link.",
    });
  }
  const httpUrl = URL.parse(input.httpBaseUrl);
  const wsUrl = input.wsBaseUrl === undefined ? null : URL.parse(input.wsBaseUrl);
  if (
    httpUrl?.protocol !== "https:" ||
    (input.wsBaseUrl !== undefined && (wsUrl?.protocol !== "wss:" || wsUrl.host !== httpUrl.host))
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "LAN HTTPS and WebSocket addresses must use the same encrypted endpoint.",
    });
  }
  const gateway = yield* ClientCapabilities.LanTlsGateway;
  yield* gateway.acquire({ httpBaseUrl: input.httpBaseUrl, tls: input.tls });
});

export const acquireRouteLanTls = (route: ConnectionRoute) => {
  const profile = Option.getOrNull(route.profile);
  return profile?._tag === "BearerConnectionProfile" ? acquireLanTls(profile) : Effect.void;
};
