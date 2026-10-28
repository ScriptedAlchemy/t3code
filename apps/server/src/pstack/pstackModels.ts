import {
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  getProviderOptionCurrentValue,
  buildProviderOptionSelectionsFromDescriptors,
  isFastProviderOptionSelection,
  withoutFastProviderOptionDescriptors,
} from "@t3tools/shared/model";
import { agentModelOptions } from "../provider/agentFastMode.ts";
import { type PstackRoleDefault } from "@t3tools/pstack";
import { invalidOptionSelections, providerConstraints } from "../provider/orchestrationTargets.ts";

interface Entry {
  readonly providerInstanceId: string;
  readonly model: string;
  readonly options: ReadonlyArray<ProviderOptionSelection>;
  readonly error?: string;
}
type Seat = { readonly kind: "inherit" } | { readonly kind: "target"; readonly target: Entry };
type ParsedSeat = { readonly kind: "inherit" } | { readonly kind: "entry"; readonly entry: Entry };

export function parseModelsFile(text: string) {
  const lines = new Map<string, ReadonlyArray<ParsedSeat>>();
  const diagnostics: string[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.split("#")[0]?.trim() ?? "";
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      diagnostics.push(`Models line ${index + 1}: expected role: value.`);
      continue;
    }
    const role = line.slice(0, colon).trim();
    if (lines.has(role))
      diagnostics.push(`Models line ${index + 1}: duplicate role ${role}; using the last value.`);
    const values = line
      .slice(colon + 1)
      .split(",")
      .filter((value) => value.trim().length > 0);
    if (values.length === 0) {
      diagnostics.push(`Models line ${index + 1}: empty role ${role}; using defaults.`);
      lines.delete(role);
      continue;
    }
    lines.set(
      role,
      values.map((value): ParsedSeat => {
        const trimmed = value.trim();
        if (trimmed === "inherit-parent" || trimmed === "auto") return { kind: "inherit" };
        const [target = "", ...tokens] = trimmed.split(/\s+/);
        const slash = target.indexOf("/");
        const options: ProviderOptionSelection[] = [];
        let error =
          slash <= 0 || slash === target.length - 1 ? "expected instance/model" : undefined;
        for (const token of tokens) {
          const equal = token.indexOf("=");
          if (equal <= 0 || equal === token.length - 1) {
            error = "expected option=value";
            continue;
          }
          const value = token.slice(equal + 1);
          options.push({
            id: token.slice(0, equal),
            value: value === "true" ? true : value === "false" ? false : value,
          });
        }
        return {
          kind: "entry",
          entry: {
            providerInstanceId: slash < 0 ? target : target.slice(0, slash),
            model: slash < 0 ? "" : target.slice(slash + 1),
            options,
            ...(error === undefined ? {} : { error }),
          },
        };
      }),
    );
  }
  return { lines, diagnostics };
}

const effortLadder = ["low", "medium", "high", "xhigh", "max"];

function defaultSeat(
  slug: string,
  providers: ReadonlyArray<ServerProvider>,
  capableInstanceIds: ReadonlySet<ProviderInstanceId>,
  diagnostics: string[],
): ParsedSeat {
  if (slug === "inherit-parent" || slug === "auto") return { kind: "inherit" };
  const fast = slug.endsWith("-fast");
  const withoutFast = fast ? slug.slice(0, -5) : slug;
  const effortMatch = /-(low|medium|high|xhigh|max)$/.exec(withoutFast);
  const model = effortMatch ? withoutFast.slice(0, effortMatch.index) : withoutFast;
  const driver = model.startsWith("claude-")
    ? "claudeAgent"
    : model.startsWith("gpt-")
      ? "codex"
      : model.startsWith("grok-")
        ? "grok"
        : model.startsWith("composer-") || model.startsWith("cursor-grok-")
          ? "cursor"
          : undefined;
  const provider = providers.find(
    (candidate) =>
      candidate.driver === driver &&
      providerConstraints(candidate, capableInstanceIds.has(candidate.instanceId)).length === 0 &&
      candidate.pool?.role !== "member" &&
      candidate.models.some((candidate) => candidate.slug === model),
  );
  const descriptors =
    provider?.models.find((candidate) => candidate.slug === model)?.capabilities
      ?.optionDescriptors ?? [];
  const options: ProviderOptionSelection[] = [];
  const effort = effortMatch?.[1];
  const descriptor = descriptors.find(
    (candidate) =>
      candidate.type === "select" &&
      candidate.options.filter((option) => effortLadder.includes(option.id)).length >= 2,
  );
  if (effort !== undefined && descriptor?.type === "select") {
    const clamped = effortLadder
      .slice(0, effortLadder.indexOf(effort) + 1)
      .findLast((value) => descriptor.options.some((option) => option.id === value));
    options.push({ id: descriptor.id, value: clamped ?? effort });
  }
  if (fast) {
    const fastMode = descriptors.find(
      (candidate) => candidate.id === "fastMode" && candidate.type === "boolean",
    );
    const serviceTier = descriptors.find(
      (candidate) =>
        candidate.id === "serviceTier" &&
        candidate.type === "select" &&
        candidate.options.some((option) => option.id === "priority" || option.id === "fast"),
    );
    if (fastMode) options.push({ id: fastMode.id, value: true });
    else if (serviceTier?.type === "select")
      options.push({
        id: serviceTier.id,
        value: serviceTier.options.some((option) => option.id === "priority") ? "priority" : "fast",
      });
    else diagnostics.push(`Default ${slug}: fast mode is not advertised; ignoring -fast.`);
  }
  return {
    kind: "entry",
    entry: {
      providerInstanceId: provider?.instanceId ?? driver ?? "unknown",
      model,
      options,
      ...(provider !== undefined && effort !== undefined && descriptor === undefined
        ? { error: "model does not advertise an effort option" }
        : {}),
    },
  };
}

export function resolveRoles(input: {
  readonly agentFastModeEnabled?: boolean;
  readonly file: ReturnType<typeof parseModelsFile> | undefined;
  readonly defaults: ReadonlyArray<PstackRoleDefault>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly capableInstanceIds: ReadonlySet<ProviderInstanceId>;
}) {
  const diagnostics = [...(input.file?.diagnostics ?? [])];
  for (const role of input.file?.lines.keys() ?? []) {
    if (!input.defaults.some((entry) => entry.label === role))
      diagnostics.push(`Unknown role ${role}; ignored.`);
  }
  const roles = input.defaults.map((role) => {
    const entries =
      input.file?.lines.get(role.label) ??
      role.defaultValue
        .split(",")
        .map((slug) =>
          defaultSeat(slug.trim(), input.providers, input.capableInstanceIds, diagnostics),
        );
    const seats = entries.map((seat, index): Seat => {
      if (seat.kind === "inherit") return seat;
      const settings = { agentFastModeEnabled: input.agentFastModeEnabled ?? true };
      const entry = { ...seat.entry, options: agentModelOptions(settings, seat.entry.options)! };
      const provider = input.providers.find(
        (provider) => provider.instanceId === entry.providerInstanceId,
      );
      const model = provider?.models.find((model) => model.slug === entry.model);
      const advertisedDescriptors = model?.capabilities?.optionDescriptors ?? [];
      const descriptors = settings.agentFastModeEnabled
        ? advertisedDescriptors
        : withoutFastProviderOptionDescriptors(advertisedDescriptors);
      let reason =
        entry.error ??
        (provider === undefined
          ? "provider instance is not registered"
          : providerConstraints(provider, input.capableInstanceIds.has(provider.instanceId)).join(
              " ",
            ) || undefined);
      reason ??= model === undefined ? "model is not advertised" : undefined;
      reason ??=
        invalidOptionSelections(entry.options, advertisedDescriptors).join(" ") || undefined;
      const options: ProviderOptionSelection[] = [];
      for (const descriptor of descriptors) {
        const value =
          entry.options.find((option) => option.id === descriptor.id)?.value ??
          getProviderOptionCurrentValue(descriptor) ??
          (descriptor.type === "boolean" ? false : undefined);
        if (value === undefined) reason ??= `option ${descriptor.id} has no current value`;
        else options.push({ id: descriptor.id, value });
      }
      reason ??= invalidOptionSelections(options, descriptors).join(" ") || undefined;
      if (reason !== undefined) {
        diagnostics.push(
          `Fallback: ${role.label} seat ${index + 1} ${entry.providerInstanceId}/${entry.model} unavailable (${reason}); runs on the parent model.`,
        );
        return { kind: "inherit" };
      }
      if (
        !settings.agentFastModeEnabled &&
        [
          ...seat.entry.options,
          ...(buildProviderOptionSelectionsFromDescriptors(advertisedDescriptors) ?? []),
        ].some(isFastProviderOptionSelection)
      ) {
        diagnostics.push(
          `Role ${role.label} seat ${index + 1}: fast mode is turned off for agents in Settings; ignoring fast options.`,
        );
      }
      return {
        kind: "target",
        target: {
          providerInstanceId: entry.providerInstanceId,
          model: entry.model,
          options: agentModelOptions(settings, options)!,
        },
      };
    });
    return { role: role.label, seats };
  });
  return { roles, diagnostics };
}

export function formatPstackBlock(input: {
  readonly skillNames: ReadonlyArray<string>;
  readonly packDir: string;
  readonly modelsPath: string;
  readonly resolved: ReturnType<typeof resolveRoles>;
}): string {
  return [
    "<t3_pstack>",
    `pstack skill: ${input.skillNames.join(", ")}`,
    `<pstack>: ${input.packDir}`,
    `<models>: ${input.modelsPath}`,
    ...input.skillNames.map(
      (name) =>
        `Read <pstack>/docs/harness/t3-code.md once, then <pstack>/skills/${name}/SKILL.md, and follow it.`,
    ),
    "Resolved roles (exact delegate_task targets; they override any model a skill or <models> names):",
    ...input.resolved.roles.map(
      ({ role, seats }) =>
        `- ${role}: ${seats.map((seat, index) => `[${index + 1}] ${seat.kind === "inherit" ? "inherit" : JSON.stringify(seat.target)}`).join(" ")}`,
    ),
    ...(input.resolved.diagnostics.length === 0
      ? []
      : ["Notes:", ...input.resolved.diagnostics.map((note) => `- ${note}`)]),
    "</t3_pstack>",
  ].join("\n");
}
