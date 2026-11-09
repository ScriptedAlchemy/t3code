import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
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

export function ProjectMemorySuggestions(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  composerDraftTarget: ComposerThreadTarget;
  onUse: (fact: ProjectFact, query: string) => void;
  onSource: (source: KnowledgeMessageRef) => void;
}) {
  const canUse = useAtomValue(projectKnowledge.prepareContext.permissionAtom(props.environmentId));
  const draft = useComposerThreadDraft(props.composerDraftTarget);
  const [request, setRequest] = useState<{ query: string; requestId: CommandId } | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlyArray<string>>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- issues one recall request after the user pauses composing a substantive draft
  useEffect(() => {
    if (request || !isSubstantiveProjectMemoryQuery(draft.prompt)) return;
    const timer = setTimeout(
      () =>
        setRequest({
          query: boundProjectMemorySuggestionQuery(draft.prompt),
          requestId: CommandId.make(randomUUID()),
        }),
      1000,
    );
    return () => clearTimeout(timer);
  }, [draft.prompt, request]);
  const result = useEnvironmentQuery(
    request
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
  const suggestions = result.data
    ? selectProjectMemorySuggestions(result.data, request?.query).filter(
        ({ fact }) => !dismissed.includes(fact.id),
      )
    : [];
  if (!request || !draft.prompt.trimStart().startsWith(request.query) || !suggestions.length)
    return null;
  return (
    <div className="flex flex-col gap-1" aria-label="Related project memory">
      {suggestions.map(({ fact, reason }) => (
        <div key={fact.id} className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate">
            Project memory: {fact.content}
            <span className="block text-muted-foreground">{reason}</span>
          </span>
          {fact.sources.some((source) => source.kind === "user") ? <span>Saved by you</span> : null}
          {fact.sources
            .filter((source) => source.kind === "message")
            .slice(0, 1)
            .flatMap((source) =>
              source.kind === "message"
                ? [
                    <Button
                      key={source.messageId}
                      variant="ghost"
                      size="sm"
                      onClick={() => props.onSource(source)}
                    >
                      Source
                    </Button>,
                  ]
                : [],
            )}
          <Button
            variant="ghost"
            size="sm"
            disabled={!canUse}
            onClick={() => props.onUse(fact, request!.query)}
          >
            Use
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDismissed([...dismissed, fact.id])}>
            Dismiss
          </Button>
        </div>
      ))}
    </div>
  );
}
