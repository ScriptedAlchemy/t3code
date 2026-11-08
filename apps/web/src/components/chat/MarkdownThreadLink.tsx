import { useEffect } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  formatHostedThreadLink,
  guessThreadLinkRef,
  percentDecodedThreadLinkId,
  type ThreadLink,
  unknownThreadLinkLabel,
} from "@t3tools/shared/threadLinks";

import { configuredHostedAppUrl } from "../../hostedPairing";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useThreadRefs, useThreadShell } from "../../state/entities";
import { threadFamilies } from "../../state/threads";
import { UnresolvedChip } from "../contextChipParts";
import { ThreadContextChip } from "../ThreadContextChip";

/** `label` is the link's written text; an autolink has none. */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly link: ThreadLink;
  readonly label: string | null;
}) {
  const environmentId = props.link.environmentId ?? props.environmentId;
  const { threadId } = props.link;
  const decodedId = percentDecodedThreadLinkId(threadId);
  const written = useThreadShell(scopeThreadRef(environmentId, threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(environmentId, decodedId) : null,
  );
  const local = written ?? decoded;
  // An idle child's shell row can come from this very read. Releasing on title arrival removes it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retains the cited families while the link is displayed
  useEffect(() => {
    const releaseWritten = threadFamilies.mount(appAtomRegistry, environmentId, threadId);
    const releaseDecoded =
      decodedId === null
        ? undefined
        : threadFamilies.mount(appAtomRegistry, environmentId, decodedId);
    return () => {
      releaseWritten();
      releaseDecoded?.();
    };
  }, [environmentId, threadId, decodedId]);
  const guess = local === null && props.link.environmentId === null;
  const refs = useThreadRefs(guess);
  const remote = useThreadShell(guess ? guessThreadLinkRef(props.link, refs) : null);
  const thread = local ?? remote;
  if (thread === null) {
    const unknown = unknownThreadLinkLabel(props.link, props.environmentId);
    return <UnresolvedChip label={props.label ?? unknown} tooltip={unknown} />;
  }
  const ref = { environmentId: thread.environmentId, threadId: thread.id };
  const title = thread.title.trim() || props.label || "Untitled thread";
  return (
    <ThreadContextChip
      record={{ ...ref, title }}
      copyMarkdown={formatHostedThreadLink(ref, title, configuredHostedAppUrl())}
    />
  );
}
