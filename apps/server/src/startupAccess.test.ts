import type * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerConfig from "./config.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";

import { describe, expect, it } from "@effect/vitest";

import {
  acceptsPrivateNetworkConnection,
  issueHeadlessServeAccessInfo,
  resolveHeadlessConnectionString,
} from "./startupAccess.ts";

const ipv4 = (address: string, internal = false): NodeOS.NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    interfaces: { en0: [ipv4("192.168.1.42")], lo0: [ipv4("127.0.0.1", true)] },
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("skips public and container addresses for a private-network listener", () => {
  const interfaces = {
    eth0: [ipv4("203.0.113.7")],
    docker0: [ipv4("172.17.0.1")],
    bridge200: [ipv4("192.168.64.1")],
    eth1: [ipv4("10.0.0.5")],
  };

  expect(resolveHeadlessConnectionString("0.0.0.0", 3773, { interfaces })).toBe(
    "http://203.0.113.7:3773",
  );
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, { interfaces, privateNetworkOnly: true }),
  ).toBe("http://10.0.0.5:3773");
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: { eth0: [ipv4("203.0.113.7")] },
      privateNetworkOnly: true,
    }),
  ).toBe("http://localhost:3773");
});

it("prefers a LAN address over a tailnet one for a private-network pairing URL", () => {
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: { tailscale0: [ipv4("100.101.102.103")], en0: [ipv4("192.168.1.42")] },
      privateNetworkOnly: true,
    }),
  ).toBe("http://192.168.1.42:3773");
});

describe("acceptsPrivateNetworkConnection", () => {
  const accepts = (localAddress: string | undefined, remoteAddress: string | undefined) =>
    acceptsPrivateNetworkConnection({ localAddress, remoteAddress });

  it("serves loopback, LAN, and tailnet clients", () => {
    expect(accepts("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(accepts("::ffff:192.168.1.20", "::ffff:192.168.1.31")).toBe(true);
    expect(accepts("100.101.102.103", "100.90.1.2")).toBe(true);
  });

  it("closes connections from or to a public address", () => {
    // A cloud VM's public address is NATed to a private interface address.
    expect(accepts("172.31.4.10", "203.0.113.7")).toBe(false);
    expect(accepts("203.0.113.7", "192.168.1.31")).toBe(false);
    expect(accepts("169.254.10.1", "169.254.10.2")).toBe(false);
    expect(accepts(undefined, "192.168.1.31")).toBe(false);
  });
});

it.effect("prints a trusted LAN link for headless startup", () =>
  Effect.gen(function* () {
    const info = yield* issueHeadlessServeAccessInfo();
    const target = resolveRemotePairingTarget({ pairingUrl: info.pairingUrl });
    expect(target.httpBaseUrl).toBe("https://192.168.1.42:3774/");
    expect(target.credential).toBe("PAIRINGCODE");
    expect(target.tls).toEqual({
      environmentId: "env-test",
      certificateAuthority: "-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n",
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.effect(
          ServerConfig.ServerConfig,
          Effect.map(ServerConfig.ServerConfig, (config) => ({
            ...config,
            host: "127.0.0.1",
            port: 3773,
            lanHttpsPort: 3774,
          })),
        ).pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-startup-https-" })),
          Layer.provide(NodeServices.layer),
        ),
        Layer.mock(HttpServer.HttpServer)({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
        }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          issueStartupPairingCredential: () =>
            Effect.succeed({
              id: "test",
              credential: "PAIRINGCODE",
              expiresAt: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
            }),
        }),
        Layer.mock(DirectEndpoints.DirectEndpoints)({
          resolve: () =>
            Effect.succeed([
              {
                kind: "lan",
                httpBaseUrl: "https://192.168.1.42:3774/",
                tls: {
                  environmentId: EnvironmentId.make("env-test"),
                  certificateAuthority:
                    "-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n",
                },
              },
            ]),
        }),
      ),
    ),
  ),
);
