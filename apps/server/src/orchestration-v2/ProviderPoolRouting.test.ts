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
  poolMemberHealth,
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
  usedPercent: null,
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

  it("spreads to the least-used member regardless of rendezvous score", () => {
    for (const [lessUsed, moreUsed] of [
      [a, b],
      [b, a],
    ] as const) {
      assert.deepEqual(
        choose([
          { ...moreUsed, usedPercent: 80 },
          { ...lessUsed, usedPercent: 20 },
        ]),
        { type: "member", instanceId: lessUsed.instanceId, reason: "spread" },
      );
    }
  });

  it("breaks equal quota ties with rendezvous scores and treats unknown usage as zero", () => {
    const expected =
      rendezvousScore(threadId, a.instanceId) > rendezvousScore(threadId, b.instanceId) ? a : b;
    for (const [aUsage, bUsage] of [
      [20, 20],
      [null, null],
      [null, 0],
      [0, null],
    ] as const) {
      assert.deepEqual(
        choose([
          { ...a, usedPercent: aUsage },
          { ...b, usedPercent: bUsage },
        ]),
        { type: "member", instanceId: expected.instanceId, reason: "spread" },
      );
    }
    assert.deepEqual(choose([{ ...a, usedPercent: 20 }, b]), {
      type: "member",
      instanceId: b.instanceId,
      reason: "spread",
    });
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

  it("shares a cooldown between members on one login email without fingerprints", () => {
    const providers = [
      stamped("claudeAgent", {
        auth: { status: "authenticated", email: " Account@Example.com " },
        limitedUntil: "2026-10-19T12:30:00.000Z",
      }),
      stamped("claudeAgent_work", {
        auth: { status: "authenticated", email: "account@example.com" },
      }),
      pool,
    ];
    const routed = route("pool_claudeAgent", providers, { instanceId: "claudeAgent_work" });
    assert.equal(routed.type, "routed");
    if (routed.type === "routed") {
      assert.deepEqual(routed.decision, {
        type: "all_limited",
        instanceId: id("claudeAgent_work"),
        earliestResetAtMs: later(30),
      });
      assert.equal(routed.selection.instanceId, "claudeAgent_work");
    }
  });

  it.each([
    {
      name: "matching normalized emails without fingerprints",
      emails: [" Account@Example.com ", "account@example.com"],
      fingerprints: [undefined, undefined],
      shares: true,
    },
    {
      name: "matching emails with only the first fingerprint",
      emails: ["account@example.com", "account@example.com"],
      fingerprints: ["fp", undefined],
      shares: true,
    },
    {
      name: "matching emails with only the second fingerprint",
      emails: ["account@example.com", "account@example.com"],
      fingerprints: [undefined, "fp"],
      shares: true,
    },
    {
      name: "different emails without fingerprints",
      emails: ["account@example.com", "other@example.com"],
      fingerprints: [undefined, undefined],
      shares: false,
    },
    {
      name: "matching fingerprints with different emails",
      emails: ["account@example.com", "other@example.com"],
      fingerprints: ["fp", "fp"],
      shares: true,
    },
    {
      name: "different fingerprints with matching emails",
      emails: ["account@example.com", "account@example.com"],
      fingerprints: ["fp", "other"],
      shares: false,
    },
    {
      name: "empty emails without fingerprints",
      emails: ["", "  "],
      fingerprints: [undefined, undefined],
      shares: false,
    },
    {
      name: "missing emails without fingerprints",
      emails: [undefined, undefined],
      fingerprints: [undefined, undefined],
      shares: false,
    },
  ])("merges cooldown and usage for $name", ({ emails, fingerprints, shares }) => {
    const health = poolMemberHealth({
      members: ["claudeAgent", "claudeAgent_work"].map((instanceId, index) =>
        stamped(instanceId, {
          auth: { status: "authenticated", email: emails[index] },
          limitedUntil: index === 0 ? "2026-10-19T12:30:00.000Z" : "2026-10-19T12:10:00.000Z",
          usageLimits: {
            checkedAt: "2026-10-19T11:00:00.000Z",
            credentialFingerprint: fingerprints[index],
            windows: [
              {
                id: "session",
                kind: "session",
                label: "Session",
                usedPercent: index === 0 ? 20 : 80,
              },
            ],
          },
        }),
      ),
      settings,
      projectId,
      nowMs,
    });
    assert.deepEqual(
      health.map((entry) => entry.limitedUntilMs),
      shares ? [later(30), later(30)] : [later(30), later(10)],
    );
    assert.deepEqual(
      health.map((entry) => entry.usedPercent),
      shares ? [80, 80] : [20, 80],
    );
  });

  it("shares the maximum window usage across every member on one credential", () => {
    const health = poolMemberHealth({
      members: [
        stamped("claudeAgent", {
          usageLimits: {
            checkedAt: "2026-10-19T11:00:00.000Z",
            credentialFingerprint: "fp",
            windows: [
              { id: "session", kind: "session", label: "Session", usedPercent: 20 },
              { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 80 },
            ],
          },
        }),
        stamped("claudeAgent_work", {
          usageLimits: {
            checkedAt: "2026-10-19T11:00:00.000Z",
            credentialFingerprint: "fp",
            windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 40 }],
          },
        }),
        provider("claudeAgent_other", {
          usageLimits: {
            checkedAt: "2026-10-19T11:00:00.000Z",
            credentialFingerprint: "other",
            windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 90 }],
          },
        }),
      ],
      settings,
      projectId,
      nowMs,
    });
    assert.deepEqual(
      health.map((entry) => entry.usedPercent),
      [80, 80, 90],
    );
  });

  it("reports unknown usage without windows and keeps ungrouped quotas separate", () => {
    const health = poolMemberHealth({
      members: [
        provider("claudeAgent"),
        provider("claudeAgent_empty", {
          usageLimits: { checkedAt: "2026-10-19T11:00:00.000Z", windows: [] },
        }),
        provider("claudeAgent_work", {
          usageLimits: {
            checkedAt: "2026-10-19T11:00:00.000Z",
            windows: [
              { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 80 },
              { id: "session", kind: "session", label: "Session", usedPercent: 20 },
            ],
          },
        }),
      ],
      settings,
      projectId,
      nowMs,
    });
    assert.deepEqual(
      health.map((entry) => entry.usedPercent),
      [null, null, 80],
    );
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
