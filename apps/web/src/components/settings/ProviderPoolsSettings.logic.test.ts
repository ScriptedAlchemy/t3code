import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderPoolCards,
  buildProviderPoolPatch,
  limitedUntilLabel,
  modelCoverageLabel,
  resolveProviderPoolName,
} from "./ProviderPoolsSettings.logic";

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

const model = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });

describe("buildProviderPoolCards", () => {
  const providers = [
    provider("codex", codex, { continuation: { groupKey: "codex:home:shared" } }),
    provider("codex_2", codex, { continuation: { groupKey: "codex:home:shared" } }),
    provider("codex_traex", codex, {
      displayName: "Traex",
      continuation: { groupKey: "codex:home:traex" },
    }),
    provider("claudeAgent", claude),
    provider("cursor", ProviderDriverKind.make("cursor")),
  ];

  it("makes a card for each driver with two or more accounts", () => {
    const cards = buildProviderPoolCards(providers, {});
    expect(cards.map((card) => [card.driver, card.label])).toEqual([[codex, "Codex"]]);
    expect(cards[0]?.candidates.map((candidate) => candidate.instanceId)).toEqual([
      "codex",
      "codex_2",
      "codex_traex",
    ]);
  });

  it("marks a third-party endpoint as separate from the accounts that share a home", () => {
    const [card] = buildProviderPoolCards(providers, {});
    const hints = card?.candidates.map((candidate) => candidate.continuationHint);
    expect(hints?.[0]).toContain("same conversations as");
    expect(hints?.[2]).toContain("switching to or from it uses a summary");
  });

  it("flags accounts signed in as the same login, ignoring email case and spacing", () => {
    const signedIn = (email: string) => ({ auth: { status: "authenticated" as const, email } });
    const [card] = buildProviderPoolCards(
      [
        provider("claudeAgent", claude, signedIn("same@example.com")),
        provider("claude_icloud", claude, {
          displayName: "Claude - iCloud",
          ...signedIn(" Same@Example.com "),
        }),
        provider("claude_work", claude, signedIn("other@example.com")),
        provider("claude_unknown", claude),
      ],
      {},
    );
    expect(card?.candidates.map((candidate) => candidate.sameLoginHint)).toEqual([
      "Same login as Claude - iCloud",
      "Same login as Claude",
      null,
      null,
    ]);
  });

  it("reflects the configured pool: ticked accounts, the switch, and whether it can be turned on", () => {
    const [off] = buildProviderPoolCards(providers, {
      [codex]: { enabled: false, memberInstanceIds: [id("codex")] },
    });
    expect(off?.candidates.map((candidate) => candidate.ticked)).toEqual([true, false, false]);
    expect(off).toMatchObject({ enabled: false, canEnable: false });

    const [on] = buildProviderPoolCards(providers, {
      [codex]: { enabled: true, memberInstanceIds: [id("codex"), id("codex_2")] },
    });
    expect(on).toMatchObject({ enabled: true, canEnable: true });
  });

  it("reports model coverage from the published pool entry", () => {
    const withPool = [
      ...providers,
      provider("pool_codex", codex, {
        models: [model("a"), model("b")],
        pool: {
          role: "pool",
          memberInstanceIds: [id("codex"), id("codex_2")],
          droppedModels: ["c"],
        },
      }),
    ];
    const cards = buildProviderPoolCards(withPool, {});
    expect(cards).toHaveLength(1);
    expect(cards[0]?.candidates).toHaveLength(3);
    expect(cards[0]?.modelCoverage).toEqual({ available: 2, total: 3 });
    expect(buildProviderPoolCards(providers, {})[0]?.modelCoverage).toBeNull();
  });
});

describe("modelCoverageLabel", () => {
  it("states the count of models every ticked account offers", () => {
    expect(modelCoverageLabel({ available: 12, total: 13 })).toBe(
      "12 of 13 models are available with the same options in every ticked account",
    );
    expect(modelCoverageLabel({ available: 6, total: 6 })).toBe(
      "All 6 models are available with the same options in every ticked account",
    );
  });
});

describe("buildProviderPoolPatch", () => {
  const config = { enabled: true, memberInstanceIds: [id("codex"), id("codex_2")] };

  it("creates a pool that is off when the first account is ticked", () => {
    expect(
      buildProviderPoolPatch(codex, undefined, {
        type: "tick",
        instanceId: id("codex"),
        ticked: true,
      }),
    ).toEqual({ [codex]: { enabled: false, memberInstanceIds: ["codex"] } });
  });

  it("appends a newly ticked account and keeps the switch as it was", () => {
    expect(
      buildProviderPoolPatch(codex, config, {
        type: "tick",
        instanceId: id("codex_traex"),
        ticked: true,
      }),
    ).toEqual({
      [codex]: { enabled: true, memberInstanceIds: ["codex", "codex_2", "codex_traex"] },
    });
  });

  it("removes only the unticked account", () => {
    expect(
      buildProviderPoolPatch(codex, config, {
        type: "tick",
        instanceId: id("codex"),
        ticked: false,
      }),
    ).toEqual({ [codex]: { enabled: true, memberInstanceIds: ["codex_2"] } });
  });

  it("removes the pool when the last account is unticked", () => {
    expect(
      buildProviderPoolPatch(
        codex,
        { enabled: false, memberInstanceIds: [id("codex")] },
        { type: "tick", instanceId: id("codex"), ticked: false },
      ),
    ).toEqual({ [codex]: null });
  });

  it("flips the switch without changing the accounts, and only patches its own driver", () => {
    expect(buildProviderPoolPatch(codex, config, { type: "enabled", enabled: false })).toEqual({
      [codex]: { enabled: false, memberInstanceIds: ["codex", "codex_2"] },
    });
  });
});

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

describe("buildProviderPoolCards for non-poolable drivers", () => {
  it("offers no card for a driver whose instances are different agents", () => {
    const acp = ProviderDriverKind.make("acpRegistry");
    const cards = buildProviderPoolCards(
      [provider("acpRegistry_devin", acp), provider("acpRegistry_other", acp)],
      {},
    );
    expect(cards).toEqual([]);
  });
});
