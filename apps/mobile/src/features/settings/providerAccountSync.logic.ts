import {
  type AccountSyncBlockReason,
  type AccountSyncEnvironment,
  planProviderAccountSync,
  type ProviderAccountSyncCell,
  syncedAccountState,
} from "@t3tools/client-runtime/state/provider-account-sync";
import type {
  EnvironmentId,
  ProviderAccountOmission,
  ProviderInstanceId,
} from "@t3tools/contracts";

export function blockNote(reason: AccountSyncBlockReason, device: string): string {
  switch (reason) {
    case "same-environment":
      return "This is the source device.";
    case "not-connected":
      return `${device} isn't connected.`;
    case "update-required":
      return `Update ${device} to sync accounts.`;
    case "permission-required":
      return `This connection can't manage providers on ${device}.`;
    case "instance-id-conflict":
      return `${device} uses this account's ID for another provider.`;
  }
}

export interface SyncDestinationChoice {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly disabled: boolean;
  readonly note: string | null;
}

export function syncDestinationChoice(input: {
  readonly source: AccountSyncEnvironment;
  readonly destination: AccountSyncEnvironment;
  readonly instanceId: ProviderInstanceId;
}): SyncDestinationChoice {
  const { source, destination, instanceId } = input;
  const plan = planProviderAccountSync({
    source,
    destinations: [destination],
    instanceIds: [instanceId],
  });
  const { environmentId, label } = destination;
  const cell = plan.cells[0];
  const block = plan.destinations[0]?.block ?? null;
  if (block !== null)
    return { environmentId, label, disabled: true, note: blockNote(block, label) };
  if (plan.sourceBlock !== null)
    return {
      environmentId,
      label,
      disabled: true,
      note: blockNote(plan.sourceBlock, source.label),
    };
  if (cell?.action === "blocked")
    return { environmentId, label, disabled: true, note: blockNote(cell.reason, label) };
  if (cell?.action === "update")
    return {
      environmentId,
      label,
      disabled: false,
      note: `Updates the copy on ${label}${cell.signedInAs ? ` (signed in as ${cell.signedInAs})` : ""}.`,
    };
  return { environmentId, label, disabled: false, note: null };
}

function omittedNote(
  omitted: ReadonlyArray<ProviderAccountOmission>,
  sourceLabel: string,
  destinationLabel: string,
): string | null {
  const names = (reason: ProviderAccountOmission["reason"]) =>
    omitted
      .filter((omission) => omission.reason === reason)
      .map(({ setting }) => (setting._tag === "ConfigField" ? setting.field : setting.name));
  const parts: Array<string> = [];
  const local = names("machine-local");
  if (local.length > 0) parts.push(`Stays on ${sourceLabel}: ${local.join(", ")}.`);
  const unsupported = names("unsupported-here");
  if (unsupported.length > 0)
    parts.push(`Not supported on ${destinationLabel}, update it: ${unsupported.join(", ")}.`);
  const missing = names("missing-on-source");
  if (missing.length > 0) parts.push(`No value on ${sourceLabel}: ${missing.join(", ")}.`);
  const oversized = names("too-large");
  if (oversized.length > 0) parts.push(`Too large to copy: ${oversized.join(", ")}.`);
  return parts.length === 0 ? null : parts.join(" ");
}

export interface SyncResultRow {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly tone: "default" | "danger";
}

export function syncResultRow(input: {
  readonly cell: ProviderAccountSyncCell;
  readonly accountLabel: string;
  readonly sourceLabel: string;
  readonly destinationLabel: string;
  /** The copy as the destination reports it; undefined until the destination lists it. */
  readonly destinationProvider: Parameters<typeof syncedAccountState>[0];
}): SyncResultRow {
  const { cell, accountLabel, sourceLabel, destinationLabel } = input;
  const key = `${cell.instanceId}:${cell.destinationEnvironmentId}`;
  const title = `${accountLabel} on ${destinationLabel}`;
  if (cell.status === "skipped") {
    const device = cell.end === "source" ? sourceLabel : destinationLabel;
    return { key, title, description: blockNote(cell.reason, device), tone: "default" };
  }
  if (cell.status === "failed") {
    return { key, title, description: cell.message, tone: "danger" };
  }
  const state = syncedAccountState(input.destinationProvider);
  const status = (() => {
    switch (state.kind) {
      case "ready":
        return `Ready${state.signedInAs ? `, signed in as ${state.signedInAs}` : ""}.`;
      case "starting":
        return `Starting on ${destinationLabel}.`;
      case "disabled":
        return `Turned off on ${destinationLabel}.`;
      case "error":
        return `Problem on ${destinationLabel}${state.message ? `: ${state.message}` : "."}`;
      case "needs-sign-in":
        return `Sign in on ${destinationLabel} to finish.`;
      case "needs-host-setup":
        return `Sign in on ${destinationLabel} with the provider's own tool.`;
    }
  })();
  const note = omittedNote(cell.omitted, sourceLabel, destinationLabel);
  return {
    key,
    title,
    description: note === null ? status : `${status} ${note}`,
    tone: state.kind === "error" ? "danger" : "default",
  };
}
