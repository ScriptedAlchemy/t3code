import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { deriveProviderInstanceEntries } from "~/providerInstances";
import { serverEnvironment } from "~/state/server";
import { ContextChipPopover } from "../contextChipParts";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getDisplayModelName, getProviderRowLabel } from "./providerIconUtils";

interface ModelMentionPresentation {
  readonly label: string;
  readonly providerLabel: string;
  readonly driverKind: ProviderDriverKind;
  readonly providerDisplayName: string;
  readonly acpRegistryIconUrl: string | undefined;
}

function presentationsEqual(left: ModelMentionPresentation, right: ModelMentionPresentation) {
  return (
    left.label === right.label &&
    left.providerLabel === right.providerLabel &&
    left.driverKind === right.driverKind &&
    left.providerDisplayName === right.providerDisplayName &&
    left.acpRegistryIconUrl === right.acpRegistryIconUrl
  );
}

// Keyed per mention so provider status pushes don't rerender every message that names a model.
const modelMentionPresentationAtom = Atom.family((key: string) =>
  Atom.make((get): ModelMentionPresentation | null => {
    const [environmentId, instanceId, model] = key.split("\u0000") as [string, string, string];
    if (!environmentId) return null;
    const providers =
      get(serverEnvironment.configValueAtom(environmentId as EnvironmentId))?.providers ?? [];
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    if (!provider) return null;
    const [entry] = deriveProviderInstanceEntries([provider]);
    const option = provider.models.find((candidate) => candidate.slug === model);
    const next: ModelMentionPresentation = {
      label: option ? getDisplayModelName(option) : model,
      providerLabel: getProviderRowLabel(entry!.displayName, option?.subProvider),
      driverKind: entry!.driverKind,
      providerDisplayName: entry!.displayName,
      acpRegistryIconUrl: entry!.acpRegistryIconUrl,
    };
    const previous = Option.getOrNull(get.self<ModelMentionPresentation | null>());
    return previous && presentationsEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("model-mention-presentation")),
);

export function ModelMentionChip(props: {
  environmentId: EnvironmentId | undefined;
  instanceId: string;
  model: string;
  source: string;
}) {
  const presentation = useAtomValue(
    modelMentionPresentationAtom(
      `${props.environmentId ?? ""}\u0000${props.instanceId}\u0000${props.model}`,
    ),
  );
  const label = presentation?.label ?? props.model;
  return (
    <ContextChipPopover
      kind="model"
      icon={
        presentation ? (
          <ProviderInstanceIcon
            driverKind={presentation.driverKind}
            displayName={presentation.providerDisplayName}
            acpRegistryIconUrl={presentation.acpRegistryIconUrl}
            className="z-auto"
            iconClassName="size-[1em]"
          />
        ) : null
      }
      label={label}
      accessibleLabel={`Model ${label}`}
      copyMarkdown={props.source}
    >
      <div className="space-y-1 p-2 text-sm">
        <p className="font-medium">{label}</p>
        <p className="text-muted-foreground">{presentation?.providerLabel ?? props.instanceId}</p>
        <p className="font-mono text-xs text-muted-foreground">{props.source}</p>
      </div>
    </ContextChipPopover>
  );
}
