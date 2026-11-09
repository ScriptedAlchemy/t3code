import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { limitedUntilLabel, resolveProviderPoolName } from "./providerAccountStatus";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const id = ProviderInstanceId.make;

function provider(
  instanceId: string,
  driver: ProviderDriverKind,
  extra: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: id(instanceId),
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-19T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...extra,
  };
}

describe("limitedUntilLabel", () => {
  const nowMs = Date.parse("2026-10-19T12:00:00.000Z");
  it("is absent without a future limit", () => {
    expect(limitedUntilLabel({}, nowMs, "locale")).toBeNull();
    expect(
      limitedUntilLabel({ limitedUntil: "2026-10-19T11:00:00.000Z" }, nowMs, "locale"),
    ).toBeNull();
  });

  it("names the time the account is available again", () => {
    expect(
      limitedUntilLabel({ limitedUntil: "2026-10-19T12:30:00.000Z" }, nowMs, "locale"),
    ).toMatch(/^Limited until /);
  });
});

describe("resolveProviderPoolName", () => {
  const pool = provider("pool_claudeAgent", claude, {
    displayName: "Claude",
    pool: { role: "pool", memberInstanceIds: [id("claudeAgent")], droppedModels: [] },
  });
  const member = provider("claudeAgent", claude, {
    pool: { role: "member", poolInstanceId: id("pool_claudeAgent") },
  });

  it("names the pool an account belongs to", () => {
    expect(resolveProviderPoolName([member, pool], member)).toBe("Claude");
  });

  it("is absent for an unpooled account or a member whose pool is not listed", () => {
    expect(resolveProviderPoolName([member, pool], provider("codex", codex))).toBeUndefined();
    expect(resolveProviderPoolName([member], member)).toBeUndefined();
    expect(resolveProviderPoolName([member], undefined)).toBeUndefined();
  });
});
