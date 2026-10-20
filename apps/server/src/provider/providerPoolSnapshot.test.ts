import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderPoolSettings,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { withProviderPools } from "./providerPoolSnapshot.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const capabilities = createModelCapabilities({ optionDescriptors: [] });

const model = (slug: string, name = slug): ServerProvider["models"][number] => ({
  slug,
  name,
  isCustom: false,
  capabilities,
});

const provider = (
  instanceId: string,
  driver: ProviderDriverKind,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver,
  displayName: instanceId,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-19T00:00:00.000Z",
  continuation: { groupKey: `claude:home:${instanceId}` },
  supportsTextGeneration: true,
  models: [model("opus"), model("sonnet")],
  slashCommands: [{ name: "compact" }, { name: "review" }],
  skills: [],
  ...overrides,
});

const pools = (settings: Record<string, ReadonlyArray<string>>): ProviderPoolSettings =>
  Object.fromEntries(
    Object.entries(settings).map(([driver, members]) => [
      driver,
      { enabled: true, memberInstanceIds: members.map((id) => ProviderInstanceId.make(id)) },
    ]),
  );

describe("withProviderPools", () => {
  const personal = provider("claudeAgent", claude);
  const work = provider("claudeAgent_work", claude, {
    models: [model("opus", "Opus (work)"), model("haiku")],
    slashCommands: [{ name: "compact" }],
  });

  it("publishes one pool entry with the model intersection and stamps the members", () => {
    const published = withProviderPools({
      providers: [personal, work, provider("codex", codex)],
      providerPools: pools({ claudeAgent: ["claudeAgent_work", "claudeAgent"] }),
    });
    const pool = published.find((entry) => entry.instanceId === "pool_claudeAgent");
    assert.deepEqual(pool?.pool, {
      role: "pool",
      memberInstanceIds: [work.instanceId, personal.instanceId],
      droppedModels: ["haiku", "sonnet"],
    });
    assert.equal(pool?.displayName, "Claude");
    assert.equal(pool?.badgeLabel, "Pool");
    assert.equal(pool?.supportsTextGeneration, false);
    assert.isUndefined(pool?.continuation);
    assert.deepEqual(
      pool?.models.map((entry) => [entry.slug, entry.name]),
      [["opus", "Opus (work)"]],
    );
    assert.deepEqual(pool?.slashCommands, [{ name: "compact" }]);
    assert.deepEqual(
      published.map((entry) => [entry.instanceId, entry.pool]),
      [
        ["claudeAgent", { role: "member", poolInstanceId: "pool_claudeAgent" }],
        ["claudeAgent_work", { role: "member", poolInstanceId: "pool_claudeAgent" }],
        ["codex", undefined],
        ["pool_claudeAgent", pool?.pool],
      ],
    );
  });

  it("shares a continuation group only when every member has the same one", () => {
    const shared = withProviderPools({
      providers: [
        provider("codex", codex, { continuation: { groupKey: "codex:home:shared" } }),
        provider("codex_2", codex, { continuation: { groupKey: "codex:home:shared" } }),
      ],
      providerPools: pools({ codex: ["codex", "codex_2"] }),
    });
    assert.deepEqual(shared.at(-1)?.continuation, { groupKey: "codex:home:shared" });
  });

  it("reports the healthiest member's status and auth", () => {
    const published = withProviderPools({
      providers: [
        provider("claudeAgent", claude, {
          status: "error",
          auth: { status: "unauthenticated" },
          checkedAt: "2026-10-19T00:00:01.000Z",
        }),
        provider("claudeAgent_work", claude, { checkedAt: "2026-10-19T00:00:02.000Z" }),
      ],
      providerPools: pools({ claudeAgent: ["claudeAgent", "claudeAgent_work"] }),
    });
    const pool = published.at(-1);
    assert.equal(pool?.status, "ready");
    assert.equal(pool?.auth.status, "authenticated");
    assert.equal(pool?.checkedAt, "2026-10-19T00:00:02.000Z");
  });

  it("publishes nothing and stamps nobody when fewer than two members are usable", () => {
    const providers = [personal, provider("claudeAgent_work", claude, { enabled: false })];
    const published = withProviderPools({
      providers,
      providerPools: pools({ claudeAgent: ["claudeAgent", "claudeAgent_work", "missing"] }),
    });
    assert.strictEqual(published, providers);
  });

  it("leaves a turned-off pool unpublished", () => {
    const published = withProviderPools({
      providers: [personal, work],
      providerPools: {
        [claude]: { enabled: false, memberInstanceIds: [personal.instanceId, work.instanceId] },
      },
    });
    assert.deepEqual(
      published.map((entry) => entry.instanceId),
      [personal.instanceId, work.instanceId],
    );
  });

  const effort = (
    choices: ReadonlyArray<string>,
    defaultChoice: string,
    overrides: { readonly id?: string; readonly label?: string } = {},
  ): ServerProvider["models"][number] => ({
    ...model("opus"),
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: overrides.id ?? "reasoningEffort",
          label: overrides.label ?? "Reasoning",
          type: "select",
          options: choices.map((choice) => ({
            id: choice,
            label: choice,
            ...(choice === defaultChoice ? { isDefault: true } : {}),
          })),
        },
      ],
    }),
  });
  const personalEffort = effort(["low", "medium", "high"], "medium");

  it.each([
    {
      label: "the same options under other labels",
      workOpus: effort(["high", "low", "medium"], "medium", { label: "Effort" }),
      shared: true,
    },
    {
      label: "an extra choice",
      workOpus: effort(["low", "medium", "high", "xhigh"], "medium"),
      shared: false,
    },
    {
      label: "another default",
      workOpus: effort(["low", "medium", "high"], "high"),
      shared: false,
    },
    {
      label: "another option id",
      workOpus: effort(["low", "medium", "high"], "medium", { id: "effort" }),
      shared: false,
    },
    { label: "no options", workOpus: { ...model("opus"), capabilities: null }, shared: false },
  ])("shares a model whose members offer $label only when its options match", (input) => {
    const pool = withProviderPools({
      providers: [
        provider("claudeAgent", claude, { models: [personalEffort, model("sonnet")] }),
        provider("claudeAgent_work", claude, { models: [input.workOpus, model("sonnet")] }),
      ],
      providerPools: pools({ claudeAgent: ["claudeAgent", "claudeAgent_work"] }),
    }).at(-1);
    assert.deepEqual(
      pool?.models.map((entry) => entry.slug),
      input.shared ? ["opus", "sonnet"] : ["sonnet"],
    );
    assert.deepEqual(
      pool?.pool?.role === "pool" ? pool.pool.droppedModels : null,
      input.shared ? [] : ["opus"],
    );
  });
});
