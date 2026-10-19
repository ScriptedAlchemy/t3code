import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  choosePoolMember,
  earliestPoolResetAtMs,
  rendezvousScore,
  routeModelSelection,
  type PoolMemberHealth,
} from "./ProviderPoolRouting.ts";

const nowMs = Date.parse("2026-10-19T12:00:00.000Z");
const later = (minutes: number) => nowMs + minutes * 60_000;
const threadId = ThreadId.make("thread:routing");
const projectId = ProjectId.make("project:routing");
const id = ProviderInstanceId.make;
const claude = ProviderDriverKind.make("claudeAgent");

const member = (
  instanceId: string,
  overrides: Partial<PoolMemberHealth> = {},
): PoolMemberHealth => ({
  instanceId: id(instanceId),
  eligible: true,
  limitedUntilMs: null,
  continuationKey: `key:${instanceId}`,
  ...overrides,
});

const choose = (
  members: ReadonlyArray<PoolMemberHealth>,
  current: { instanceId: string; busy?: boolean } | null = null,
  excluded: ReadonlyArray<string> = [],
) =>
  choosePoolMember({
    members,
    threadId,
    current:
      current === null ? null : { instanceId: id(current.instanceId), busy: current.busy ?? false },
    excluded: new Set(excluded.map((entry) => id(entry))),
    nowMs,
  });

describe("choosePoolMember", () => {
  const a = member("a");
  const b = member("b");
  const c = member("c");

  it("ranks busy, then affinity, then a shared continuation, then spread", () => {
    const cooling = { limitedUntilMs: later(10) };
    assert.deepEqual(choose([{ ...a, ...cooling }, b], { instanceId: "a", busy: true }), {
      type: "member",
      instanceId: id("a"),
      reason: "busy",
    });
    assert.deepEqual(choose([a, b], { instanceId: "a" }), {
      type: "member",
      instanceId: id("a"),
      reason: "affinity",
    });
    assert.deepEqual(
      choose([{ ...a, ...cooling }, b, { ...c, continuationKey: a.continuationKey }], {
        instanceId: "a",
      }),
      { type: "member", instanceId: id("c"), reason: "same_continuation" },
    );
    assert.equal(choose([{ ...a, ...cooling }, b, c], { instanceId: "a" }).type, "member");
    assert.equal(choose([a, b, c]).type, "member");
  });

  it("spreads new threads deterministically and leaves other threads alone when a member cools", () => {
    const members = [a, b, c];
    const threads = Array.from({ length: 40 }, (_, index) => ThreadId.make(`thread:${index}`));
    const pick = (thread: ThreadId, pool: ReadonlyArray<PoolMemberHealth>) => {
      const decision = choosePoolMember({
        members: pool,
        threadId: thread,
        current: null,
        excluded: new Set(),
        nowMs,
      });
      return decision.type === "member" ? decision.instanceId : null;
    };
    const first = threads.map((thread) => pick(thread, members));
    assert.deepEqual(
      threads.map((thread) => pick(thread, members)),
      first,
    );
    assert.isAtLeast(new Set(first).size, 2);
    const withoutB = [a, { ...b, limitedUntilMs: later(5) }, c];
    for (const [index, thread] of threads.entries()) {
      if (first[index] !== "b") assert.equal(pick(thread, withoutB), first[index]);
      else assert.notEqual(pick(thread, withoutB), id("b"));
    }
    assert.equal(rendezvousScore(threadId, id("a")), rendezvousScore(threadId, id("a")));
  });

  it("skips excluded members and reports when every member is unusable", () => {
    assert.deepEqual(choose([a, b], { instanceId: "a" }, ["a"]), {
      type: "member",
      instanceId: id("b"),
      reason: "spread",
    });
    assert.deepEqual(choose([a, { ...b, eligible: false }], null, ["a"]), {
      type: "no_eligible_member",
    });
  });

  it("stays on the current member with the earliest reset when every member is cooling", () => {
    const cooling = [
      { ...a, limitedUntilMs: later(30) },
      { ...b, limitedUntilMs: later(10) },
    ];
    assert.deepEqual(choose(cooling, { instanceId: "a" }), {
      type: "all_limited",
      instanceId: id("a"),
      earliestResetAtMs: later(10),
    });
    assert.deepEqual(choose(cooling), {
      type: "all_limited",
      instanceId: id("b"),
      earliestResetAtMs: later(10),
    });
    assert.equal(earliestPoolResetAtMs(cooling, nowMs), later(10));
    assert.isNull(earliestPoolResetAtMs([a, ...cooling], nowMs));
  });
});

describe("routeModelSelection", () => {
  const provider = (
    instanceId: string,
    overrides: Partial<ServerProvider> = {},
  ): ServerProvider => ({
    instanceId: id(instanceId),
    driver: claude,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-19T00:00:00.000Z",
    continuation: { groupKey: `claude:home:${instanceId}` },
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  });
  const pool = provider("pool_claudeAgent", {
    pool: {
      role: "pool",
      memberInstanceIds: [id("claudeAgent"), id("claudeAgent_work")],
      droppedModels: [],
    },
  });
  const stamped = (instanceId: string, overrides: Partial<ServerProvider> = {}) =>
    provider(instanceId, {
      pool: { role: "member", poolInstanceId: pool.instanceId },
      ...overrides,
    });
  const settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [id("claudeAgent_work")]: { driver: claude, enabled: true, config: {} },
    },
    providerPools: {
      [claude]: { enabled: true, memberInstanceIds: [id("claudeAgent"), id("claudeAgent_work")] },
    },
  };
  const route = (
    selectionInstanceId: string,
    providers: ReadonlyArray<ServerProvider>,
    current: { instanceId: string; busy?: boolean } | null = null,
    overrides: Partial<ServerSettings> = {},
  ) =>
    routeModelSelection({
      selection: { instanceId: id(selectionInstanceId), model: "opus" },
      providers,
      settings: { ...settings, ...overrides },
      projectId,
      threadId,
      current:
        current === null
          ? null
          : { instanceId: id(current.instanceId), busy: current.busy ?? false },
      nowMs,
    });

  it("routes a selection naming the pool or a member to a concrete member", () => {
    const providers = [stamped("claudeAgent"), stamped("claudeAgent_work"), pool];
    for (const named of ["pool_claudeAgent", "claudeAgent_work"]) {
      const routed = route(named, providers, { instanceId: "claudeAgent" });
      assert.equal(routed.type, "routed");
      if (routed.type === "routed") {
        assert.deepEqual(routed.selection, { instanceId: id("claudeAgent"), model: "opus" });
        assert.equal(routed.decision.type, "member");
      }
    }
  });

  it("shares a cooldown between members on one credential", () => {
    const providers = [
      stamped("claudeAgent", {
        limitedUntil: "2026-10-19T12:30:00.000Z",
        usageLimits: {
          checkedAt: "2026-10-19T11:00:00.000Z",
          windows: [],
          credentialFingerprint: "fp",
        },
      }),
      stamped("claudeAgent_work", {
        usageLimits: {
          checkedAt: "2026-10-19T11:00:00.000Z",
          windows: [],
          credentialFingerprint: "fp",
        },
      }),
      pool,
    ];
    const routed = route("pool_claudeAgent", providers, { instanceId: "claudeAgent" });
    assert.equal(routed.type, "routed");
    if (routed.type === "routed") {
      assert.equal(routed.decision.type, "all_limited");
      assert.equal(routed.selection.instanceId, "claudeAgent");
    }
  });

  it("reports no eligible member when the project turned every member off", () => {
    const routed = route(
      "pool_claudeAgent",
      [stamped("claudeAgent"), stamped("claudeAgent_work"), pool],
      null,
      {
        projectSettingsOverrides: {
          [projectId]: {
            providerInstances: {
              [id("claudeAgent")]: { enabled: false },
              [id("claudeAgent_work")]: { enabled: false },
            },
          },
        },
      },
    );
    assert.equal(routed.type, "no_eligible_member");
  });

  it("returns an unpooled selection by reference and resolves a dangling pool id", () => {
    const codex = provider("codex", { driver: ProviderDriverKind.make("codex") });
    const selection = { instanceId: id("codex"), model: "gpt" };
    const unrouted = routeModelSelection({
      selection,
      providers: [codex],
      settings,
      projectId,
      threadId,
      current: null,
      nowMs,
    });
    assert.equal(unrouted.type, "unrouted");
    if (unrouted.type === "unrouted") assert.strictEqual(unrouted.selection, selection);

    const unpooled = [provider("claudeAgent"), provider("claudeAgent_work"), codex];
    assert.deepEqual(route("pool_claudeAgent", unpooled, { instanceId: "claudeAgent_work" }), {
      type: "unrouted",
      selection: { instanceId: id("claudeAgent_work"), model: "opus" },
    });
    assert.deepEqual(route("pool_claudeAgent", unpooled, { instanceId: "codex" }), {
      type: "unrouted",
      selection: { instanceId: id("claudeAgent"), model: "opus" },
    });
  });
});
