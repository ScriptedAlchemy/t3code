import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  findProviderPool,
  isReservedProviderInstanceId,
  providerLimitedUntilMs,
  providerPoolDriver,
} from "./providerPool.ts";
import { ServerProvider } from "./server.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const id = ProviderInstanceId.make;

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
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
    expect(providerPoolDriver(id("pool_claudeAgent"))).toBe(claude);
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
