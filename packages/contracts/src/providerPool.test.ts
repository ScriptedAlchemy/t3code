import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  findProviderPool,
  isReservedProviderInstanceId,
  ProviderPoolSettings,
  providerLimitedUntilMs,
  providerPoolDriver,
  providerPoolInstanceId,
  resolveActiveProviderPools,
} from "./providerPool.ts";
import { ServerProvider } from "./server.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const id = ProviderInstanceId.make;

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const decodePoolSettings = Schema.decodeUnknownSync(ProviderPoolSettings);
const provider = (instanceId: string, driver: ProviderDriverKind, extra: object = {}) =>
  decodeProvider({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-19T00:00:00.000Z",
    models: [],
    ...extra,
  });

describe("pool instance ids", () => {
  it("round-trips a driver through its pool id", () => {
    expect(providerPoolInstanceId(claude)).toBe("pool_claudeAgent");
    expect(providerPoolDriver(providerPoolInstanceId(claude))).toBe(claude);
  });

  it("finds no driver in an ordinary instance id", () => {
    expect(providerPoolDriver(id("claudeAgent"))).toBeNull();
    expect(providerPoolDriver(id("claudeAgent_pool_x"))).toBeNull();
  });

  it("reserves the pool prefix and nothing else", () => {
    expect(isReservedProviderInstanceId("pool_codex")).toBe(true);
    expect(isReservedProviderInstanceId("pool_")).toBe(true);
    expect(isReservedProviderInstanceId("codex_pool")).toBe(false);
    expect(isReservedProviderInstanceId("pooled")).toBe(false);
  });
});

describe("resolveActiveProviderPools", () => {
  const instances = [
    { instanceId: id("claudeAgent"), driver: claude, enabled: true },
    { instanceId: id("claudeAgent_icloud"), driver: claude, enabled: true },
    { instanceId: id("claudeAgent_off"), driver: claude, enabled: false },
    { instanceId: id("codex"), driver: codex, enabled: true },
    { instanceId: id("codex_2"), driver: codex, enabled: true },
  ];
  const resolve = (providerPools: unknown) =>
    resolveActiveProviderPools({
      providerPools: decodePoolSettings(providerPools),
      instances,
    });

  it("activates a pool of two enabled same-driver members, in pool order", () => {
    expect(
      resolve({ claudeAgent: { memberInstanceIds: ["claudeAgent_icloud", "claudeAgent"] } }),
    ).toEqual([
      {
        driver: claude,
        instanceId: "pool_claudeAgent",
        memberInstanceIds: ["claudeAgent_icloud", "claudeAgent"],
      },
    ]);
  });

  it("ignores disabled, unknown, wrong-driver, and repeated members", () => {
    expect(
      resolve({
        claudeAgent: {
          memberInstanceIds: [
            "claudeAgent",
            "claudeAgent_off",
            "claudeAgent_removed",
            "codex",
            "claudeAgent",
            "claudeAgent_icloud",
          ],
        },
      }),
    ).toEqual([
      {
        driver: claude,
        instanceId: "pool_claudeAgent",
        memberInstanceIds: ["claudeAgent", "claudeAgent_icloud"],
      },
    ]);
  });

  it("leaves a pool inactive with fewer than two usable members", () => {
    expect(
      resolve({ claudeAgent: { memberInstanceIds: ["claudeAgent", "claudeAgent_off"] } }),
    ).toEqual([]);
    expect(resolve({ codex: { memberInstanceIds: ["codex"] } })).toEqual([]);
  });

  it("leaves a turned-off pool inactive", () => {
    expect(resolve({ codex: { enabled: false, memberInstanceIds: ["codex", "codex_2"] } })).toEqual(
      [],
    );
  });
});

describe("findProviderPool", () => {
  const pool = provider("pool_claudeAgent", claude, {
    pool: {
      role: "pool",
      memberInstanceIds: ["claudeAgent_icloud", "claudeAgent"],
      droppedModels: [],
    },
  });
  const member = (instanceId: string) =>
    provider(instanceId, claude, { pool: { role: "member", poolInstanceId: "pool_claudeAgent" } });
  const providers = [
    member("claudeAgent"),
    member("claudeAgent_icloud"),
    pool,
    provider("codex", codex),
  ];

  it("finds the pool and its members, in pool order, by the pool id or a member id", () => {
    for (const instanceId of ["pool_claudeAgent", "claudeAgent"]) {
      const found = findProviderPool(providers, id(instanceId));
      expect(found?.pool.instanceId).toBe("pool_claudeAgent");
      expect(found?.members.map((entry) => entry.instanceId)).toEqual([
        "claudeAgent_icloud",
        "claudeAgent",
      ]);
    }
  });

  it("finds nothing for an unpooled or unknown instance", () => {
    expect(findProviderPool(providers, id("codex"))).toBeNull();
    expect(findProviderPool(providers, id("missing"))).toBeNull();
  });

  it("finds nothing for a member whose pool entry is not listed", () => {
    expect(findProviderPool([member("claudeAgent")], id("claudeAgent"))).toBeNull();
  });
});

describe("providerLimitedUntilMs", () => {
  const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

  it("reports a future cooldown and drops a past, absent, or unreadable one", () => {
    expect(providerLimitedUntilMs({ limitedUntil: "2026-10-19T12:15:00.000Z" }, nowMs)).toBe(
      nowMs + 15 * 60_000,
    );
    expect(providerLimitedUntilMs({ limitedUntil: "2026-10-19T12:00:00.000Z" }, nowMs)).toBeNull();
    expect(providerLimitedUntilMs({}, nowMs)).toBeNull();
    expect(providerLimitedUntilMs({ limitedUntil: "soon" }, nowMs)).toBeNull();
  });
});

describe("ServerProvider.pool", () => {
  it("decodes a role this build does not know as an unpooled account", () => {
    const decoded = provider("claudeAgent", claude, { pool: { role: "weighted", weight: 2 } });
    expect(decoded.instanceId).toBe("claudeAgent");
    expect(decoded.pool).toBeUndefined();
  });
});

describe("poolable drivers", () => {
  it("ignores a pool configured for a driver whose instances are not accounts of one service", () => {
    const acp = ProviderDriverKind.make("acpRegistry");
    const pools = resolveActiveProviderPools({
      providerPools: decodePoolSettings({
        acpRegistry: { enabled: true, memberInstanceIds: ["acpRegistry_a", "acpRegistry_b"] },
        claudeAgent: { enabled: true, memberInstanceIds: ["claudeAgent", "claudeAgent_b"] },
      }),
      instances: [
        provider("acpRegistry_a", acp),
        provider("acpRegistry_b", acp),
        provider("claudeAgent", claude),
        provider("claudeAgent_b", claude),
      ],
    });
    expect(pools.map((pool) => pool.driver)).toEqual([claude]);
  });
});
