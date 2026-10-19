import { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  composerInstanceIdFor,
  composerModelSelectionFor,
  foldProviderPoolsForComposer,
  providerPoolOf,
} from "./providerPools.ts";

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
const member = (instanceId: string) =>
  provider(instanceId, claude, { pool: { role: "member", poolInstanceId: "pool_claudeAgent" } });

const pool = provider("pool_claudeAgent", claude, {
  pool: {
    role: "pool",
    memberInstanceIds: ["claudeAgent", "claudeAgent_icloud"],
    droppedModels: [],
  },
});
const providers = [
  provider("codex", codex),
  member("claudeAgent"),
  member("claudeAgent_icloud"),
  pool,
];

const ids = (list: ReadonlyArray<ServerProvider>) => list.map((entry) => entry.instanceId);

describe("foldProviderPoolsForComposer", () => {
  it("lists the pool in place of its members and keeps unpooled instances", () => {
    expect(ids(foldProviderPoolsForComposer(providers))).toEqual(["codex", "pool_claudeAgent"]);
  });

  it("keeps a member visible when its pool entry is missing", () => {
    expect(
      ids(foldProviderPoolsForComposer([provider("codex", codex), member("claudeAgent")])),
    ).toEqual(["codex", "claudeAgent"]);
  });

  it("leaves a list without pools unchanged", () => {
    const unpooled = [provider("codex", codex), provider("claudeAgent", claude)];
    expect(ids(foldProviderPoolsForComposer(unpooled))).toEqual(["codex", "claudeAgent"]);
  });
});

describe("composerInstanceIdFor", () => {
  it("maps a member to its pool so a thread on a hidden account selects the pool", () => {
    expect(composerInstanceIdFor(providers, id("claudeAgent_icloud"))).toBe("pool_claudeAgent");
  });

  it("keeps a pool id, an unpooled id, and an unknown id as they are", () => {
    expect(composerInstanceIdFor(providers, id("pool_claudeAgent"))).toBe("pool_claudeAgent");
    expect(composerInstanceIdFor(providers, id("codex"))).toBe("codex");
    expect(composerInstanceIdFor(providers, id("missing"))).toBe("missing");
  });
});

describe("composerModelSelectionFor", () => {
  it("moves a selection on a pooled account to its pool and keeps the rest of it", () => {
    const selection = {
      instanceId: id("claudeAgent_icloud"),
      model: "opus",
      options: [{ id: "effort", value: "high" }],
    };
    expect(composerModelSelectionFor(providers, selection)).toEqual({
      ...selection,
      instanceId: "pool_claudeAgent",
    });
  });

  it("returns the same selection when it is not on a pooled account", () => {
    const selection = { instanceId: id("codex"), model: "gpt-5" };
    expect(composerModelSelectionFor(providers, selection)).toBe(selection);
  });
});

describe("providerPoolOf", () => {
  it("returns the pool entry for a member or the pool, and null otherwise", () => {
    expect(providerPoolOf(providers, id("claudeAgent"))).toBe(pool);
    expect(providerPoolOf(providers, id("pool_claudeAgent"))).toBe(pool);
    expect(providerPoolOf(providers, id("codex"))).toBeNull();
  });
});
