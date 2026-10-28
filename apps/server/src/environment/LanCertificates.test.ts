// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttps from "node:https";
import * as NodeEvents from "node:events";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { loadLanCertificates } from "./LanCertificates.ts";

it.live("renews a LAN certificate under the same authority and rejects damaged state", () =>
  Effect.gen(function* () {
    let bytes: Uint8Array | undefined;
    const store = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeed(Option.fromUndefinedOr(bytes)),
      set: (_name, value) =>
        Effect.sync(() => {
          bytes = value;
        }),
      create: (_name, value) =>
        Effect.sync(() => {
          bytes = value;
        }),
      remove: () => Effect.void,
      getOrCreateRandom: () => Effect.die("unused"),
    });
    const load = (names: string[], now: number, establishedAuthority?: string) =>
      loadLanCertificates(names, now, establishedAuthority).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, store),
      );
    const now = yield* Clock.currentTimeMillis;
    const first = yield* load(["127.0.0.1"], now);
    const renewed = yield* load(["127.0.0.1", "192.168.1.3"], now);
    assert.equal(renewed.authorityCertificate, first.authorityCertificate);
    assert.notEqual(renewed.certificate, first.certificate);
    assert.equal(
      new NodeCrypto.X509Certificate(renewed.certificate).checkIP("192.168.1.3"),
      "192.168.1.3",
    );
    yield* Effect.promise(async () => {
      const server = NodeHttps.createServer(
        { key: renewed.key, cert: renewed.certificate },
        (_request, response) => response.end("secure"),
      );
      server.listen(0, "127.0.0.1");
      await NodeEvents.EventEmitter.once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing server address");
      const request = (ca: string, servername?: string) =>
        new Promise<string>((resolve, reject) => {
          const req = NodeHttps.get(
            { host: "127.0.0.1", port: address.port, ca, ...(servername ? { servername } : {}) },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk: string) => {
                body += chunk;
              });
              response.on("end", () => resolve(body));
            },
          );
          req.on("error", reject);
        });
      try {
        assert.equal(await request(renewed.authorityCertificate), "secure");
        await expect(request(renewed.authorityCertificate, "wrong.example")).rejects.toMatchObject({
          code: "ERR_TLS_CERT_ALTNAME_INVALID",
        });
        await expect(request("")).rejects.toMatchObject({
          code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });

    const later = yield* load(["127.0.0.1"], now + 24 * 24 * 60 * 60 * 1000);
    assert.equal(later.authorityCertificate, first.authorityCertificate);
    assert.notEqual(later.certificate, renewed.certificate);
    const beforeExpiry = bytes;
    const expired = yield* Effect.exit(load(["127.0.0.1"], now + 3651 * 24 * 60 * 60 * 1000));
    assert.equal(expired._tag, "Failure");
    assert.equal(bytes, beforeExpiry);
    bytes = undefined;
    const missing = yield* Effect.exit(load(["127.0.0.1"], now, first.authorityCertificate));
    assert.equal(missing._tag, "Failure");
    assert.equal(bytes, undefined);
    const replacement = yield* load(["127.0.0.1"], now);
    const replacementBytes = bytes;
    assert.notEqual(replacement.authorityCertificate, first.authorityCertificate);
    const changed = yield* Effect.exit(load(["127.0.0.1"], now, first.authorityCertificate));
    assert.equal(changed._tag, "Failure");
    assert.equal(bytes, replacementBytes);
    bytes = new TextEncoder().encode("{}");
    const failed = yield* Effect.exit(load(["127.0.0.1"], now));
    assert.equal(failed._tag, "Failure");
  }),
);
