// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- This Node transport boundary validates X.509 certificates and supplies a scoped fetch adapter.
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import type { LanTlsTrust } from "@t3tools/contracts";
import { Agent, fetch as undiciFetch } from "undici";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import WebSocket from "ws";

import { isPrivateNetworkHost, normalizeHostname } from "./hostClassification.ts";

export const createLanTlsClient = (input: {
  readonly httpBaseUrl: string;
  readonly tls: LanTlsTrust;
}) => {
  const origin = new URL(input.httpBaseUrl);
  const hostname = normalizeHostname(origin.hostname);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    (!isIP(hostname) && hostname !== "localhost") ||
    !isPrivateNetworkHost(hostname)
  ) {
    throw new Error("LAN TLS trust requires a private HTTPS address.");
  }
  const pem = input.tls.certificateAuthority;
  if (
    !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]{1,8192}-----END CERTIFICATE-----\s*$/.test(
      pem,
    )
  ) {
    throw new Error("LAN TLS trust requires one certificate authority.");
  }
  const authority = new X509Certificate(pem);
  const now = Date.now();
  if (
    !authority.ca ||
    !authority.checkIssued(authority) ||
    !authority.verify(authority.publicKey) ||
    authority.validFromDate.getTime() > now ||
    authority.validToDate.getTime() <= now
  ) {
    throw new Error("LAN TLS certificate authority is invalid or expired.");
  }
  const dispatcher = new Agent({ connect: { ca: pem, rejectUnauthorized: true } });
  const lifetime = new AbortController();
  const sockets = new Set<WebSocket>();
  let closing: Promise<void> | undefined;

  const checkUrl = (value: string | URL, protocol: "https:" | "wss:") => {
    const url = new URL(value);
    if (
      lifetime.signal.aborted ||
      url.protocol !== protocol ||
      url.host !== origin.host ||
      url.username ||
      url.password
    ) {
      throw new Error("LAN TLS request is outside the enrolled origin or its trust was revoked.");
    }
    return url;
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    checkUrl(request.url, "https:");
    const response = await undiciFetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      body: request.body as NodeReadableStream<Uint8Array> | null,
      duplex: "half",
      dispatcher,
      redirect: "manual",
      signal: AbortSignal.any([request.signal, lifetime.signal]),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("LAN TLS requests cannot follow redirects.");
    }
    return new Response(response.body as ReadableStream<Uint8Array> | null, {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
    });
  };

  const openWebSocket = (url: string | URL, protocols?: string | string[]) => {
    const target = checkUrl(url, "wss:");
    const socket = new WebSocket(target, protocols, {
      ca: pem,
      rejectUnauthorized: true,
      followRedirects: false,
    });
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };

  const close = (): Promise<void> => {
    closing ??= (async () => {
      lifetime.abort(new Error("LAN TLS trust was revoked."));
      const closed = [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
            socket.once("error", () => undefined);
            socket.terminate();
          }),
      );
      await Promise.all([dispatcher.destroy(), ...closed]);
    })();
    return closing;
  };

  return { fetch, openWebSocket, close };
};
