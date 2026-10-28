// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Real TLS fixtures use WebCrypto key material and fixed certificate validity dates.
import "@abraham/reflection";
import { KeyObject } from "node:crypto";
import {
  BasicConstraintsExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { EnvironmentId } from "@t3tools/contracts";

export const makeTlsFixture = async (
  options: { san?: string; expired?: boolean; expiredAuthority?: boolean } = {},
) => {
  const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const authorityKeys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const start = new Date("2020-01-01T00:00:00Z");
  const end = new Date("2100-01-01T00:00:00Z");
  const expired = new Date("2021-01-01T00:00:00Z");
  const authority = await X509CertificateGenerator.createSelfSigned({
    name: "CN=T3 test authority",
    keys: authorityKeys,
    signingAlgorithm: algorithm,
    notBefore: start,
    notAfter: options.expiredAuthority ? expired : end,
    extensions: [new BasicConstraintsExtension(true, 0, true)],
  });
  const certificate = await X509CertificateGenerator.create({
    issuer: authority.subject,
    subject: "CN=T3 test server",
    publicKey: keys.publicKey,
    signingKey: authorityKeys.privateKey,
    signingAlgorithm: algorithm,
    notBefore: start,
    notAfter: options.expired ? expired : end,
    extensions: [
      new BasicConstraintsExtension(false),
      new SubjectAlternativeNameExtension([{ type: "ip", value: options.san ?? "127.0.0.1" }]),
    ],
  });
  return {
    key: KeyObject.from(keys.privateKey).export({ type: "pkcs8", format: "pem" }),
    cert: certificate.toString("pem"),
    tls: {
      environmentId: EnvironmentId.make("test-environment"),
      certificateAuthority: authority.toString("pem"),
    },
  };
};
