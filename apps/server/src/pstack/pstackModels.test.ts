import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../provider/ClaudeModelCatalog.ts";
import { formatPstackBlock, parseModelsFile, resolveRoles } from "./pstackModels.ts";

const effort = (id: string): ProviderOptionDescriptor => ({
  id,
  label: "Effort",
  type: "select",
  options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({
    id,
    label: id,
    isDefault: id === "medium",
  })),
});
const provider = (
  instanceId: string,
  driver: string,
  model: string,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-25T00:00:00Z",
  slashCommands: [],
  skills: [],
  models: [
    { slug: model, name: model, isCustom: false, capabilities: { optionDescriptors: descriptors } },
  ],
});
const providers = [
  {
    ...provider("claudeAgent", "claudeAgent", "claude-opus-5-5", []),
    models: BUNDLED_CLAUDE_MODEL_CATALOG.models.map(({ model }) => model),
  },
  provider("codex", "codex", "gpt-6-astra", [
    effort("reasoningEffort"),
    {
      id: "serviceTier",
      label: "Tier",
      type: "select",
      options: ["default", "priority"].map((id) => ({ id, label: id })),
      currentValue: "default",
    },
  ]),
];
const defaults = [
  {
    label: "architect runners",
    defaultValue: "claude-opus-5-5-xhigh, gpt-6-astra-high-fast",
  },
];
const capableInstanceIds = new Set(providers.map((provider) => provider.instanceId));
const availability = {
  settings: DEFAULT_SERVER_SETTINGS,
  projectId: ProjectId.make("pstack"),
  nowMs: Date.parse("2026-10-25T00:00:00Z"),
};
const file =
  "# budget: balanced\narchitect runners: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6-astra reasoningEffort=high";

it.effect("leaves speed to the provider unless the models file sets it", () =>
  Effect.sync(() => {
    const resolved = resolveRoles({
      ...availability,
      file: parseModelsFile(file),
      defaults,
      providers,
      capableInstanceIds,
    });
    const targets = resolved.roles[0]!.seats.map((seat) => {
      assert.equal(seat.kind, "target");
      return seat.kind === "target" ? seat.target : undefined;
    });
    assert.deepEqual(targets, [
      {
        providerInstanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "xhigh" }],
      },
      {
        providerInstanceId: "codex",
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    ]);
    const explicit = resolveRoles({
      file: parseModelsFile(
        "architect runners: codex/gpt-6-astra reasoningEffort=high serviceTier=priority",
      ),
      defaults,
      providers,
      capableInstanceIds,
    });
    assert.deepEqual(explicit.roles[0]!.seats[0], {
      kind: "target",
      target: {
        providerInstanceId: "codex",
        model: "gpt-6-astra",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      },
    });
  }),
);

it.effect("disabled providers fall back visibly without shrinking panels", () =>
  Effect.sync(() => {
    const result = resolveRoles({
      ...availability,
      file: parseModelsFile(file),
      defaults,
      providers: providers.map((provider) => ({ ...provider, enabled: false })),
      capableInstanceIds,
    });
    assert.deepEqual(result.roles[0]!.seats, [{ kind: "inherit" }, { kind: "inherit" }]);
    assert.equal(
      result.diagnostics[0],
      "Fallback: architect runners seat 1 claudeAgent/claude-opus-5-5 unavailable (Provider instance is disabled.); runs on the parent model.",
    );
  }),
);
it.effect("missing models file maps upstream family and effort, ignoring -fast", () =>
  Effect.sync(() => {
    const result = resolveRoles({
      ...availability,
      file: undefined,
      defaults,
      providers,
      capableInstanceIds,
    });
    assert.deepEqual(result.diagnostics, []);
    const seat = result.roles[0]!.seats[1]!;
    assert.deepEqual(seat, {
      kind: "target",
      target: {
        providerInstanceId: "codex",
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  }),
);
it.effect.each(["effort=ultra", "unknown=true", "fastMode=yes", "effort=high effort=low"])(
  "invalid option %s falls back",
  (option) =>
    Effect.sync(() => {
      const result = resolveRoles({
        ...availability,
        file: parseModelsFile(`architect runners: claudeAgent/claude-opus-5-5 ${option}`),
        defaults,
        providers,
        capableInstanceIds,
      });
      assert.deepEqual(result.roles[0]!.seats, [{ kind: "inherit" }]);
      assert.equal(result.diagnostics.length, 1);
    }),
);
it.effect("preserves explicit panel cardinality, aliases, comments and model slashes", () =>
  Effect.sync(() => {
    const parsed = parseModelsFile(
      "# budget: high\narchitect runners: auto, inherit-parent, missing/vendor/model option=false # note",
    );
    const result = resolveRoles({
      ...availability,
      file: parsed,
      defaults,
      providers,
      capableInstanceIds,
    });
    assert.equal(result.roles[0]!.seats.length, 3);
    assert.include(result.diagnostics[0]!, "missing/vendor/model");
  }),
);
it.effect("recognizes Pi-style thinking as effort", () =>
  Effect.sync(() => {
    const piStyle = provider("custom-codex", "codex", "gpt-6-astra", [effort("thinking")]);
    const result = resolveRoles({
      ...availability,
      file: undefined,
      defaults: [{ label: "runner", defaultValue: "gpt-6-astra-xhigh-fast" }],
      providers: [piStyle],
      capableInstanceIds: new Set([piStyle.instanceId]),
    });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.roles[0]!.seats, [
      {
        kind: "target",
        target: {
          providerInstanceId: "custom-codex",
          model: "gpt-6-astra",
          options: [{ id: "thinking", value: "xhigh" }],
        },
      },
    ]);
  }),
);
it.effect("unregistered adapters and missing current values cannot leak parent options", () =>
  Effect.sync(() => {
    const unsupported = resolveRoles({
      ...availability,
      file: parseModelsFile(file),
      defaults,
      providers,
      capableInstanceIds: new Set(),
    });
    assert.include(unsupported.diagnostics[0]!, "No V2 provider adapter");
    const incomplete = provider("codex", "codex", "gpt-6-astra", [
      {
        id: "thinking",
        type: "select",
        label: "Thinking",
        options: [{ id: "high", label: "High" }],
      },
    ]);
    const result = resolveRoles({
      ...availability,
      file: parseModelsFile("architect runners: codex/gpt-6-astra"),
      defaults,
      providers: [incomplete],
      capableInstanceIds,
    });
    assert.include(result.diagnostics[0]!, "option thinking has no current value");
  }),
);
it.effect("formats the adapter block exactly and omits empty notes", () =>
  Effect.sync(() => {
    assert.equal(
      formatPstackBlock({
        skillNames: ["architect", "arena"],
        packDir: "/pack",
        modelsPath: "/models.md",
        resolved: {
          roles: [{ role: "architect runners", seats: [{ kind: "inherit" }] }],
          diagnostics: [],
        },
      }),
      [
        "<t3_pstack>",
        "pstack skill: architect, arena",
        "<pstack>: /pack",
        "<models>: /models.md",
        "Read <pstack>/docs/harness/t3-code.md once, then <pstack>/skills/architect/SKILL.md, and follow it.",
        "Read <pstack>/docs/harness/t3-code.md once, then <pstack>/skills/arena/SKILL.md, and follow it.",
        "Resolved roles (exact delegate_task targets; they override any model a skill or <models> names):",
        "- architect runners: [1] inherit",
        "</t3_pstack>",
      ].join("\n"),
    );
  }),
);

it.effect.each(["claude-opus-5-5", "claude-sonnet-4-6"])(
  "completes bundled Claude %s descriptors without synthetic current values",
  (model) =>
    Effect.sync(() => {
      const result = resolveRoles({
        ...availability,
        file: parseModelsFile(`architect runners: claudeAgent/${model}`),
        defaults,
        providers,
        capableInstanceIds,
      });
      assert.deepEqual(result.diagnostics, []);
      const seat = result.roles[0]!.seats[0]!;
      assert.equal(seat.kind, "target");
      if (seat.kind === "target") {
        const descriptors = providers[0]!.models.find((entry) => entry.slug === model)!
          .capabilities!.optionDescriptors!;
        assert.deepEqual(
          seat.target.options,
          descriptors
            .filter((descriptor) => descriptor.id !== "fastMode")
            .map((descriptor) => ({
              id: descriptor.id,
              value:
                descriptor.type === "boolean"
                  ? false
                  : descriptor.options.find((option) => option.isDefault)!.id,
            })),
        );
      }
    }),
);
it.effect("completes a Pi thinking select from isDefault", () =>
  Effect.sync(() => {
    const pi = provider("pi", "pi", "vendor/model", [effort("thinking")]);
    const result = resolveRoles({
      ...availability,
      file: parseModelsFile("architect runners: pi/vendor/model"),
      defaults,
      providers: [pi],
      capableInstanceIds: new Set([pi.instanceId]),
    });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.roles[0]!.seats, [
      {
        kind: "target",
        target: {
          providerInstanceId: "pi",
          model: "vendor/model",
          options: [{ id: "thinking", value: "medium" }],
        },
      },
    ]);
  }),
);
it.effect("default seats skip unhealthy and incapable instances offering the model", () =>
  Effect.sync(() => {
    const first = providers[1]!;
    const unhealthy = {
      ...first,
      instanceId: ProviderInstanceId.make("unhealthy"),
      installed: false,
    };
    const incapable = { ...first, instanceId: ProviderInstanceId.make("incapable") };
    const result = resolveRoles({
      ...availability,
      file: undefined,
      defaults,
      providers: [unhealthy, incapable, ...providers],
      capableInstanceIds: new Set([...capableInstanceIds, unhealthy.instanceId]),
    });
    assert.deepEqual(result.diagnostics, []);
    const seat = result.roles[0]!.seats[1]!;
    assert.equal(seat.kind === "target" && seat.target.providerInstanceId, "codex");
  }),
);
it.effect("clamps default effort below its budget", () =>
  Effect.sync(() => {
    const codex = provider("codex", "codex", "gpt-6-astra", [
      {
        id: "reasoningEffort",
        label: "Effort",
        type: "select",
        options: ["low", "high", "ultra"].map((id) => ({
          id,
          label: id,
          isDefault: id === "high",
        })),
      },
      {
        id: "serviceTier",
        label: "Tier",
        type: "select",
        options: [
          { id: "default", label: "Default", isDefault: true },
          { id: "fast", label: "Fast" },
        ],
      },
    ]);
    const result = resolveRoles({
      ...availability,
      file: undefined,
      defaults: [{ label: "architect runners", defaultValue: "gpt-6-astra-xhigh-fast" }],
      providers: [codex],
      capableInstanceIds,
    });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.roles[0]!.seats, [
      {
        kind: "target",
        target: {
          providerInstanceId: "codex",
          model: "gpt-6-astra",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
    ]);
  }),
);
it.effect("reports unknown role labels and ignores empty comma entries", () =>
  Effect.sync(() => {
    const result = resolveRoles({
      ...availability,
      file: parseModelsFile("archtect runners: auto\narchitect runners: auto,, inherit-parent, "),
      defaults,
      providers,
      capableInstanceIds,
    });
    assert.deepEqual(result.roles[0]!.seats, [{ kind: "inherit" }, { kind: "inherit" }]);
    assert.include(result.diagnostics[0]!, "Unknown role archtect runners");
  }),
);

it.effect.each(["", " ,,", " # comment"])(
  "empty role value %s uses defaults with a diagnostic",
  (value) =>
    Effect.sync(() => {
      const result = resolveRoles({
        ...availability,
        file: parseModelsFile(`architect runners:${value}`),
        defaults,
        providers,
        capableInstanceIds,
      });
      const expected = resolveRoles({
        ...availability,
        file: undefined,
        defaults,
        providers,
        capableInstanceIds,
      });
      assert.deepEqual(result.roles, expected.roles);
      assert.include(result.diagnostics.join("\n"), "empty role architect runners; using defaults");
    }),
);
