// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- X.509 issuance requires native key parsing and explicit certificate validity dates.
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
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const DAY = 24 * 60 * 60 * 1000;
const SECRET = "lan-tls";

class LanCertificateError extends Data.TaggedError("LanCertificateError")<{
  readonly cause: unknown;
}> {}
const algorithm = { name: "ECDSA", namedCurve: "P-256" };
const signingAlgorithm = { name: "ECDSA", hash: "SHA-256" };
const crypto = globalThis.crypto;

const CertificateState = Schema.Struct({
  version: Schema.Literal(1),
  authorityCertificate: Schema.String,
  authorityKey: Schema.String,
  certificate: Schema.String,
  key: Schema.String,
});
const decodeState = Schema.decodeSync(Schema.fromJsonString(CertificateState));
const encodeState = Schema.encodeSync(Schema.fromJsonString(CertificateState));

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
    crypto,
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
    crypto,
  );
  return { certificate: certificate.toString("pem"), key: await privatePem(keys.privateKey) };
}

function parseState(bytes: Uint8Array, now: number) {
  const result = decodeState(new TextDecoder().decode(bytes));
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
  establishedAuthority?: string,
) {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const bytes = yield* store.get(SECRET);
  const state = yield* Effect.tryPromise({
    try: async () => {
      if (Option.isNone(bytes)) {
        if (establishedAuthority !== undefined) throw new Error("LAN TLS authority is missing");
        const authority = await newAuthority(now);
        return {
          version: 1 as const,
          ...authority,
          ...(await newLeaf(authority.authorityCertificate, authority.authorityKey, names, now)),
        };
      }
      const current = parseState(bytes.value, now);
      if (
        establishedAuthority !== undefined &&
        current.authorityCertificate !== establishedAuthority
      ) {
        throw new Error("LAN TLS authority changed while the listener was running");
      }
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
  const encoded = new TextEncoder().encode(encodeState(state));
  if (Option.isNone(bytes)) yield* store.create(SECRET, encoded);
  else if (!Buffer.from(bytes.value).equals(Buffer.from(encoded)))
    yield* store.set(SECRET, encoded);
  return state;
});
