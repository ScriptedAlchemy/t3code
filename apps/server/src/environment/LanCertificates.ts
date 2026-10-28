// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
import "@abraham/reflection";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const DAY = 24 * 60 * 60 * 1000;
const SECRET = "lan-tls";

export class LanCertificateError extends Data.TaggedError("LanCertificateError")<{
  readonly cause: unknown;
}> {}
const algorithm = { name: "ECDSA", namedCurve: "P-256" };
const signingAlgorithm = { name: "ECDSA", hash: "SHA-256" };
const crypto = NodeCrypto.webcrypto;

type CertificateState = {
  version: 1;
  authorityCertificate: string;
  authorityKey: string;
  certificate: string;
  key: string;
};

const pem = (label: string, bytes: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${Buffer.from(bytes)
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END ${label}-----\n`;

async function keyPair() {
  return crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
}

async function privatePem(key: NodeCrypto.webcrypto.CryptoKey) {
  return pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", key));
}

function checkKey(certificate: NodeCrypto.X509Certificate, key: string) {
  const publicKey = NodeCrypto.createPublicKey(NodeCrypto.createPrivateKey(key)).export({
    type: "spki",
    format: "der",
  });
  if (!certificate.publicKey.export({ type: "spki", format: "der" }).equals(publicKey)) {
    throw new Error("LAN TLS certificate and private key do not match");
  }
}

async function newAuthority(now: number) {
  const keys = await keyPair();
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      name: "CN=T3 Code LAN CA",
      keys,
      notBefore: new Date(now - DAY),
      notAfter: new Date(now + 3650 * DAY),
      signingAlgorithm,
      extensions: [
        new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
      ],
    },
    crypto as never,
  );
  return {
    authorityCertificate: certificate.toString("pem"),
    authorityKey: await privatePem(keys.privateKey),
  };
}

async function newLeaf(
  authorityCertificate: string,
  authorityKey: string,
  names: readonly string[],
  now: number,
) {
  const keys = await keyPair();
  const key = NodeCrypto.createPrivateKey(authorityKey).export({ type: "pkcs8", format: "der" });
  const signingKey = await crypto.subtle.importKey("pkcs8", key, algorithm, false, ["sign"]);
  const issuer = new NodeCrypto.X509Certificate(authorityCertificate).subject;
  const certificate = await X509CertificateGenerator.create(
    {
      subject: "CN=T3 Code LAN",
      issuer,
      publicKey: keys.publicKey,
      signingKey,
      notBefore: new Date(now - DAY),
      notAfter: new Date(now + 30 * DAY),
      signingAlgorithm,
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
        new SubjectAlternativeNameExtension(
          names.map((name) => ({ type: NodeNet.isIP(name) ? "ip" : "dns", value: name })),
        ),
      ],
    },
    crypto as never,
  );
  return { certificate: certificate.toString("pem"), key: await privatePem(keys.privateKey) };
}

function parseState(bytes: Uint8Array, now: number): CertificateState {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof value !== "object" || value === null) throw new Error("Malformed LAN TLS state");
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    ["authorityCertificate", "authorityKey", "certificate", "key"].some(
      (key) => typeof state[key] !== "string",
    )
  ) {
    throw new Error("Malformed LAN TLS state");
  }
  const result = state as CertificateState;
  const authority = new NodeCrypto.X509Certificate(result.authorityCertificate);
  const certificate = new NodeCrypto.X509Certificate(result.certificate);
  checkKey(authority, result.authorityKey);
  checkKey(certificate, result.key);
  if (
    !authority.ca ||
    !authority.verify(authority.publicKey) ||
    !certificate.verify(authority.publicKey) ||
    Date.parse(authority.validFrom) > now ||
    Date.parse(authority.validTo) <= now
  ) {
    throw new Error("Invalid or expired LAN TLS authority");
  }
  return result;
}

export const loadLanCertificates = Effect.fn("loadLanCertificates")(function* (
  names: readonly string[],
  now: number,
) {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const bytes = yield* store.get(SECRET);
  const state = yield* Effect.tryPromise({
    try: async () => {
      if (Option.isNone(bytes)) {
        const authority = await newAuthority(now);
        return {
          version: 1 as const,
          ...authority,
          ...(await newLeaf(authority.authorityCertificate, authority.authorityKey, names, now)),
        };
      }
      const current = parseState(bytes.value, now);
      const certificate = new NodeCrypto.X509Certificate(current.certificate);
      if (
        Date.parse(certificate.validTo) > now + 7 * DAY &&
        Date.parse(certificate.validFrom) <= now &&
        names.every((name) =>
          NodeNet.isIP(name) ? certificate.checkIP(name) : certificate.checkHost(name),
        )
      )
        return current;
      return {
        ...current,
        ...(await newLeaf(current.authorityCertificate, current.authorityKey, names, now)),
      };
    },
    catch: (cause) => new LanCertificateError({ cause }),
  });
  const encoded = new TextEncoder().encode(JSON.stringify(state));
  if (Option.isNone(bytes)) yield* store.create(SECRET, encoded);
  else if (!Buffer.from(bytes.value).equals(Buffer.from(encoded)))
    yield* store.set(SECRET, encoded);
  return state;
});
