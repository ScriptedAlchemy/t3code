// @effect-diagnostics nodeBuiltinImport:off -- These integration tests run actual HTTPS listeners.
import { once } from "node:events";
import { createServer } from "node:https";
import type { RequestListener } from "node:http";
import type { Duplex } from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import { WebSocketServer } from "ws";

import { createLanTlsClient } from "./nodeLanTls.ts";
import { makeTlsFixture } from "./nodeLanTls.testkit.ts";

const serve = async (
  fixture: Awaited<ReturnType<typeof makeTlsFixture>>,
  handler: RequestListener,
) => {
  const server = createServer(fixture, handler);
  const connections = new Set<Duplex>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
  return {
    server,
    url: `https://127.0.0.1:${address.port}`,
    async [Symbol.asyncDispose]() {
      const closed = once(server, "close");
      server.close();
      for (const socket of connections) socket.destroy();
      await closed;
    },
  };
};

describe("scoped LAN TLS", () => {
  it("streams request and response bodies under the enrolled CA", async () => {
    const fixture = await makeTlsFixture();
    await using host = await serve(fixture, (request, response) => {
      response.setHeader("x-seen-authorization", request.headers.authorization ?? "none");
      request.pipe(response);
    });
    const client = createLanTlsClient({ httpBaseUrl: host.url, tls: fixture.tls });
    try {
      const request = new Request(`${host.url}/echo`, {
        method: "POST",
        headers: { authorization: "Bearer test-secret" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("streamed payload"));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit);
      const response = await client.fetch(request);
      expect(response.headers.get("x-seen-authorization")).toBe("Bearer test-secret");
      expect(await response.text()).toBe("streamed payload");
    } finally {
      await client.close();
    }
  });

  it.each(["wrong authority", "wrong SAN", "expired leaf"])(
    "rejects %s before sending credentials",
    async (failure) => {
      const fixture = await makeTlsFixture({
        ...(failure === "wrong SAN" ? { san: "127.0.0.2" } : {}),
        expired: failure === "expired leaf",
      });
      let requests = 0;
      await using host = await serve(fixture, (_, response) => {
        requests++;
        response.end("unexpected");
      });
      const trusted = failure === "wrong authority" ? await makeTlsFixture() : fixture;
      const client = createLanTlsClient({ httpBaseUrl: host.url, tls: trusted.tls });
      try {
        await expect(
          client.fetch(host.url, { headers: { authorization: "Bearer test-secret" } }),
        ).rejects.toThrow("fetch failed");
        expect(requests).toBe(0);
      } finally {
        await client.close();
      }
    },
  );

  it("rejects public origins, non-CA certificates, expired roots and CA bundles", async () => {
    const fixture = await makeTlsFixture();
    const expired = await makeTlsFixture({ expiredAuthority: true });
    for (const url of [
      "https://8.8.8.8",
      "https://example.com",
      "http://127.0.0.1",
      "https://user:password@127.0.0.1",
    ]) {
      expect(() => createLanTlsClient({ httpBaseUrl: url, tls: fixture.tls })).toThrow(
        "private HTTPS address",
      );
    }
    for (const certificateAuthority of [
      fixture.cert,
      expired.tls.certificateAuthority,
      `${fixture.tls.certificateAuthority}\n${fixture.tls.certificateAuthority}`,
    ]) {
      expect(() =>
        createLanTlsClient({
          httpBaseUrl: "https://127.0.0.1",
          tls: { ...fixture.tls, certificateAuthority },
        }),
      ).toThrow(/certificate authority|one certificate/);
    }
  });

  it("rejects other origins and ports and never follows credential-bearing redirects", async () => {
    const fixture = await makeTlsFixture();
    let leaks = 0;
    await using other = await serve(fixture, (_, response) => {
      leaks++;
      response.end("leaked");
    });
    await using host = await serve(fixture, (_, response) => {
      response.writeHead(307, { location: other.url });
      response.end();
    });
    const client = createLanTlsClient({ httpBaseUrl: host.url, tls: fixture.tls });
    try {
      for (const url of [
        other.url,
        host.url.replace("127.0.0.1", "127.0.0.2"),
        host.url.replace("https:", "http:"),
      ]) {
        await expect(
          client.fetch(url, { headers: { authorization: "Bearer test-secret" } }),
        ).rejects.toThrow("outside the enrolled origin");
        expect(() => client.openWebSocket(url.replace("https:", "wss:"))).toThrow(
          "outside the enrolled origin",
        );
      }
      await expect(
        client.fetch(host.url, { method: "POST", body: "pairing-code", redirect: "follow" }),
      ).rejects.toThrow("cannot follow redirects");
      expect(leaks).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("aborts streaming responses, rejects new work and closes WSS on revocation", async () => {
    const fixture = await makeTlsFixture();
    await using host = await serve(fixture, (_, response) => {
      response.writeHead(200);
      response.write("first");
    });
    const ws = new WebSocketServer({ server: host.server });
    ws.on("connection", (socket) => socket.send("verified websocket"));
    const client = createLanTlsClient({ httpBaseUrl: host.url, tls: fixture.tls });
    const socket = client.openWebSocket(host.url.replace("https:", "wss:"));
    const message = once(socket, "message");
    expect(String((await message)[0])).toBe("verified websocket");
    const response = await client.fetch(host.url);
    const reading = response.text();
    const aborted = expect(reading).rejects.toThrow();
    const closed = once(socket, "close");
    await client.close();
    await aborted;
    await closed;
    await client.close();
    await expect(client.fetch(host.url)).rejects.toThrow("trust was revoked");
    expect(() => client.openWebSocket(host.url.replace("https:", "wss:"))).toThrow(
      "trust was revoked",
    );
    ws.close();
  });

  it("honors caller aborts and refuses untrusted WSS handshakes", async () => {
    const fixture = await makeTlsFixture();
    const wrong = await makeTlsFixture();
    await using host = await serve(fixture, (_, response) => {
      response.writeHead(200);
      response.write("first");
    });
    const ws = new WebSocketServer({ server: host.server });
    let connections = 0;
    ws.on("connection", () => {
      connections++;
    });
    const client = createLanTlsClient({ httpBaseUrl: host.url, tls: fixture.tls });
    const invalid = createLanTlsClient({ httpBaseUrl: host.url, tls: wrong.tls });
    try {
      const controller = new AbortController();
      const response = await client.fetch(host.url, { signal: controller.signal });
      const read = expect(response.text()).rejects.toThrow();
      controller.abort();
      await read;
      const socket = invalid.openWebSocket(host.url.replace("https:", "wss:"));
      const [error] = await once(socket, "error");
      expect(error.message).toMatch(/certificate|issuer/);
      expect(connections).toBe(0);
    } finally {
      await client.close();
      await invalid.close();
      ws.close();
    }
  });
});
