import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { BrainIcon } from "lucide-react";
import {
  CommandId,
  type EnvironmentId,
  type ProjectId,
  type ProjectFact,
  type KnowledgeMessageRef,
} from "@t3tools/contracts";
import {
  boundProjectMemorySuggestionQuery,
  isSubstantiveProjectMemoryQuery,
  selectProjectMemorySuggestions,
} from "@t3tools/client-runtime/projectKnowledge";
import { useComposerThreadDraft, type ComposerThreadTarget } from "../../composerDraftStore";
import { useEnvironmentQuery } from "../../state/query";
import { projectKnowledge } from "../../state/projectKnowledge";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";

type SuggestionState = {
  readonly scopeKey: string;
  readonly request: { query: string; requestId: CommandId } | null;
  readonly dismissed: ReadonlyArray<string>;
};

/** Saved project facts related to the draft, as composer notices. */
export function useProjectMemorySuggestions(props: {
  enabled: boolean;
  scopeKey: string;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  composerDraftTarget: ComposerThreadTarget;
  onUse: (fact: ProjectFact, query: string) => void;
  onSource: (source: KnowledgeMessageRef) => void;
}): ReadonlyArray<ComposerBannerStackItem> {
  const canUse = useAtomValue(projectKnowledge.prepareContext.permissionAtom(props.environmentId));
  const draft = useComposerThreadDraft(props.composerDraftTarget);
  const [stored, setStored] = useState<SuggestionState | null>(null);
  const state =
    stored?.scopeKey === props.scopeKey
      ? stored
      : { scopeKey: props.scopeKey, request: null, dismissed: [] };
  const { request, dismissed } = state;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- issues one recall request after the user pauses composing a substantive draft
  useEffect(() => {
    if (!props.enabled || request || !isSubstantiveProjectMemoryQuery(draft.prompt)) return;
    const timer = setTimeout(
      () =>
        setStored({
          scopeKey: props.scopeKey,
          request: {
            query: boundProjectMemorySuggestionQuery(draft.prompt),
            requestId: CommandId.make(randomUUID()),
          },
          dismissed: [],
        }),
      1000,
    );
    return () => clearTimeout(timer);
  }, [props.enabled, props.scopeKey, draft.prompt, request]);
  const result = useEnvironmentQuery(
    props.enabled && request
      ? projectKnowledge.search({
          environmentId: props.environmentId,
          input: {
            ...request,
            projectId: props.projectId,
            recordRetrieval: false,
            preview: true,
            minTrust: 0.5,
            limit: 8,
            messageLimit: 1,
          },
        })
      : null,
  );
  if (
    !props.enabled ||
    !request ||
    !result.data ||
    !draft.prompt.trimStart().startsWith(request.query)
  ) {
    return [];
  }
  return selectProjectMemorySuggestions(result.data, request.query)
    .filter(({ fact }) => !dismissed.includes(fact.id))
    .map(({ fact, reason }) => {
      const source = fact.sources.find((candidate) => candidate.kind === "message");
      const savedByYou = fact.sources.some((candidate) => candidate.kind === "user");
      return {
        id: `project-memory:${fact.id}`,
        variant: "info",
        icon: <BrainIcon />,
        title: fact.content,
        description: savedByYou ? `Saved by you. ${reason}` : reason,
        actions: (
          <>
            {source?.kind === "message" ? (
              <Button size="xs" variant="ghost" onClick={() => props.onSource(source)}>
                Source
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              disabled={!canUse}
              onClick={() => props.onUse(fact, request.query)}
            >
              Use
            </Button>
          </>
        ),
        dismissLabel: "Dismiss project memory suggestion",
        onDismiss: () => setStored({ ...state, dismissed: [...dismissed, fact.id] }),
      } satisfies ComposerBannerStackItem;
    });
}
