import { randomUUID } from "../../lib/utils";
import { useEffect, useRef, useState } from "react";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  CommandId,
  ProjectFactId,
  type EnvironmentId,
  type KnowledgeFactSource,
  type KnowledgeMessageRef,
  type KnowledgeSelection,
  type KnowledgeSourceUnavailableReason,
  type MessageId,
  type ProjectFact,
  type ProjectId,
  type ProjectKnowledgeMutation,
  type ProjectKnowledgeSearchInput,
  type ThreadId,
} from "@t3tools/contracts";
import { projectKnowledgeContextRecord } from "@t3tools/client-runtime/projectKnowledge";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { projectKnowledge } from "../../state/projectKnowledge";
import {
  useComposerDraftStore,
  useComposerThreadDraft,
  type ComposerThreadTarget,
  type DraftId,
} from "../../composerDraftStore";

const selectionKey = (selection: KnowledgeSelection) =>
  selection.kind === "fact"
    ? `fact:${selection.factId}`
    : `message:${selection.threadId}:${selection.messageId}`;
const labels = (text: string) => [
  ...new Set(
    text
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean),
  ),
];
type Scope = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  draftId?: DraftId;
};
type ProjectScope = Pick<Scope, "environmentId" | "projectId">;
type MessageCitation = { readonly threadId: ThreadId; readonly messageId: MessageId };
// The digest is optional so a timeline message can be cited before the server
// has hashed it; readSource returns the canonical ref.
type SourceRef = MessageCitation & { readonly digest?: KnowledgeMessageRef["digest"] };

const UNAVAILABLE_SOURCE_LABEL: Record<KnowledgeSourceUnavailableReason, string> = {
  missing: "Source missing",
  deleted: "Source deleted",
  archived: "Source archived",
  wrong_project: "Source moved",
  streaming: "Source still streaming",
  changed: "Source changed",
};

// The dialog is opened from the thread panel, timeline messages, the command
// palette and a keybinding, so its open state lives outside any one of them.
type OpenRequest = ProjectScope & {
  readonly message: MessageCitation | null;
  readonly key: number;
};
const openRequestAtom = Atom.make<OpenRequest | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("chat:project-memory"),
);
let nextRequestKey = 0;

export function useProjectMemoryAvailable(environmentId: EnvironmentId | null): boolean {
  const config = useAtomValue(
    serverEnvironment.configValueAtom(environmentId ?? ("" as EnvironmentId)),
  );
  return environmentId !== null && config?.environment.capabilities.projectKnowledge === true;
}

export function useOpenProjectMemory() {
  const setRequest = useAtomSet(openRequestAtom);
  return (scope: ProjectScope & { readonly message?: MessageCitation }) =>
    setRequest({
      environmentId: scope.environmentId,
      projectId: scope.projectId,
      message: scope.message ?? null,
      key: ++nextRequestKey,
    });
}

export function ProjectMemoryPanel(props: ProjectScope) {
  const available = useProjectMemoryAvailable(props.environmentId);
  const open = useOpenProjectMemory();
  if (!available) return null;
  return (
    <Button variant="ghost" size="sm" onClick={() => open(props)}>
      Project memory
    </Button>
  );
}

export function ProjectMemoryDialogHost(props: Scope) {
  const available = useProjectMemoryAvailable(props.environmentId);
  const [request, setRequest] = useAtom(openRequestAtom);
  useEffect(() => () => setRequest(null), [setRequest]);
  const active =
    available &&
    request !== null &&
    request.environmentId === props.environmentId &&
    request.projectId === props.projectId
      ? request
      : null;
  return (
    <Dialog
      open={active !== null}
      onOpenChange={(open) => {
        if (!open) setRequest(null);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Project memory</DialogTitle>
          <DialogDescription>
            Find cited conversations, curate project facts, and choose evidence for your next
            message.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {active ? (
            <MemoryContents
              key={`${active.key}:${props.threadId}:${props.draftId ?? ""}`}
              {...props}
              seedMessage={active.message}
            />
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function MemoryContents(props: Scope & { readonly seedMessage: MessageCitation | null }) {
  const target: ComposerThreadTarget = props.draftId ?? {
    environmentId: props.environmentId,
    threadId: props.threadId,
  };
  const draft = useComposerThreadDraft(target);
  const attached = draft.knowledgeContexts?.[0];
  const [selections, setSelections] = useState<ReadonlyArray<KnowledgeSelection>>(
    attached?.knowledge.selections ?? [],
  );
  const [query, setQuery] = useState("");
  const [searchInput, setSearchInput] = useState<ProjectKnowledgeSearchInput | null>(null);
  const [status, setStatus] = useState<"confirmed" | "proposed" | "forgotten">("confirmed");
  const [afterId, setAfterId] = useState<ProjectFactId | undefined>();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [source, setSource] = useState<SourceRef | null>(props.seedMessage);
  const [editing, setEditing] = useState<ProjectFact | null>(null);
  const [content, setContent] = useState("");
  const [entities, setEntities] = useState("");
  const [tags, setTags] = useState("");
  const [kind, setKind] = useState<"decision" | "constraint" | "convention" | "note">("note");
  const [sources, setSources] = useState<ReadonlyArray<KnowledgeFactSource>>([{ kind: "user" }]);
  const [prefillPending, setPrefillPending] = useState(props.seedMessage !== null);
  const selectionVersion = useRef(0);
  useEffect(
    () => () => {
      selectionVersion.current += 1;
    },
    [],
  );
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canMutate = useAtomValue(projectKnowledge.mutate.permissionAtom(props.environmentId));
  const list = useEnvironmentQuery(
    projectKnowledge.list({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, status, ...(afterId ? { afterId } : {}) },
    }),
  );
  const search = useEnvironmentQuery(
    searchInput
      ? projectKnowledge.search({ environmentId: props.environmentId, input: searchInput })
      : null,
  );
  const sourceQuery = useEnvironmentQuery(
    source
      ? projectKnowledge.readSource({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, ...source, includeArchived },
        })
      : null,
  );
  if (
    prefillPending &&
    sourceQuery.data?.state === "available" &&
    sourceQuery.data.source.messageId === props.seedMessage?.messageId
  ) {
    setPrefillPending(false);
    setContent(sourceQuery.data.text.slice(0, 12000));
    setSources([sourceQuery.data.source]);
  }
  const mutate = useAtomCommand(projectKnowledge.mutate, { reportFailure: false });
  const prepare = useAtomCommand(projectKnowledge.prepareContext, { reportFailure: false });
  const toggle = (selection: KnowledgeSelection) => {
    selectionVersion.current += 1;
    setPreview(null);
    useComposerDraftStore.getState().setKnowledgeContext(target, null);
    setSelections((current) =>
      current.some((item) => selectionKey(item) === selectionKey(selection))
        ? current.filter((item) => selectionKey(item) !== selectionKey(selection))
        : [...current, selection].slice(0, 20),
    );
  };
  const restartSearch = () =>
    setSearchInput((current) =>
      current === null
        ? null
        : {
            projectId: current.projectId,
            query: current.query,
            includeArchived: current.includeArchived ?? false,
            requestId: CommandId.make(randomUUID()),
          },
    );
  const apply = async (input: ProjectKnowledgeMutation) => {
    setBusy(true);
    setError(null);
    setPreview(null);
    selectionVersion.current += 1;
    const result = await mutate({ environmentId: props.environmentId, input });
    setBusy(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else {
      useComposerDraftStore.getState().setKnowledgeContext(target, null);
      setEditing(null);
      setContent("");
      setSelections((current) =>
        current.filter((item) => item.kind !== "fact" || item.factId !== result.value.id),
      );
    }
    list.refresh();
    restartSearch();
  };
  const revise = (fact: ProjectFact, action: "confirm" | "forget" | "feedback", helpful = true) => {
    const fields = {
      commandId: CommandId.make(randomUUID()),
      projectId: props.projectId,
      factId: fact.id,
      expectedRevision: fact.revision,
    };
    return apply(action === "feedback" ? { ...fields, action, helpful } : { ...fields, action });
  };
  const attach = async () => {
    const version = ++selectionVersion.current;
    setBusy(true);
    setError(null);
    setPreview(null);
    const context = {
      environmentId: props.environmentId,
      projectId: props.projectId,
      selections,
      includeArchived,
      maxBytes: 48000,
    };
    const result = await prepare({ environmentId: props.environmentId, input: context });
    setBusy(false);
    if (selectionVersion.current !== version) return;
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else {
      setPreview(result.value.text);
      useComposerDraftStore
        .getState()
        .setKnowledgeContext(target, projectKnowledgeContextRecord(result.value.context));
    }
  };
  const facts = searchInput
    ? search.data?.facts.state === "available"
      ? search.data.facts.matches.map((match) => match.fact)
      : []
    : (list.data?.facts ?? []);
  // Search already drops facts whose citations no longer resolve.
  const unavailableReasons = new Map(
    searchInput
      ? []
      : (list.data?.unavailableSources ?? []).map((item) => [item.factId, item.reason]),
  );
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearchInput(
            query.trim().length < 2
              ? null
              : {
                  projectId: props.projectId,
                  query: query.trim(),
                  includeArchived,
                  requestId: CommandId.make(randomUUID()),
                },
          );
        }}
      >
        <Input
          aria-label="Search project knowledge"
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <label>
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => {
            selectionVersion.current += 1;
            setIncludeArchived(event.target.checked);
            useComposerDraftStore.getState().setKnowledgeContext(target, null);
            setSearchInput(null);
            setPreview(null);
          }}
        />{" "}
        Include archived conversations
      </label>
      <div className="flex flex-wrap gap-2">
        {(["confirmed", "proposed", "forgotten"] as const).map((value) => (
          <Button
            key={value}
            variant={status === value && !searchInput ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setStatus(value);
              setAfterId(undefined);
              setSearchInput(null);
            }}
          >
            {value}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            list.refresh();
            restartSearch();
          }}
        >
          Refresh
        </Button>
      </div>
      {(error ?? list.error ?? search.error) ? (
        <p role="alert">{error ?? list.error ?? search.error}</p>
      ) : null}
      {list.isPending || search.isPending ? <p>Reading project knowledge…</p> : null}
      {search.data?.facts.state === "unavailable" ? (
        <p>
          Fact ranking is unavailable on this environment. Conversation search and saved facts
          remain available.
        </p>
      ) : null}
      {search.data?.facts.state === "available" && search.data.facts.coverage === "partial" ? (
        <p>Partial coverage. Narrow the query to reach more facts.</p>
      ) : null}
      {facts.map((fact) => {
        const score =
          search.data?.facts.state === "available"
            ? search.data.facts.matches.find((match) => match.fact.id === fact.id)?.score
            : undefined;
        const unavailableReason = unavailableReasons.get(fact.id);
        return (
          <article className="rounded-md border p-3" key={fact.id}>
            {unavailableReason ? (
              <Badge variant="warning">{UNAVAILABLE_SOURCE_LABEL[unavailableReason]}</Badge>
            ) : null}
            <p className="whitespace-pre-wrap">{fact.content ?? "Forgotten fact"}</p>
            <p className="text-xs text-muted-foreground">
              {fact.kind} · {fact.status} · trust {fact.trust.toFixed(2)} · revision {fact.revision}
            </p>
            <p>
              {fact.origin.kind === "user"
                ? "User assertion"
                : fact.origin.kind === "agent-thread"
                  ? `Agent observation in thread ${fact.origin.threadId}`
                  : `Agent observation from ${fact.origin.label}`}
            </p>
            <div className="flex flex-wrap gap-2">
              {fact.sources.map((ref, index) =>
                ref.kind === "user" ? (
                  <span key={index}>User assertion</span>
                ) : (
                  <Button key={index} variant="link" size="sm" onClick={() => setSource(ref)}>
                    Message {ref.messageId}
                  </Button>
                ),
              )}
            </div>
            {score ? (
              <details>
                <summary>Why this matched</summary>
                <p>
                  Holographic {score.holographic.toFixed(3)} · Text {score.lexical.toFixed(3)} ·
                  Overlap {score.tokenOverlap.toFixed(3)} · Age {score.temporalDecay.toFixed(3)} ·
                  Use {score.reinforcement.toFixed(3)} · Trust {score.trust.toFixed(2)} · Score{" "}
                  {score.combined.toFixed(6)}
                </p>
                <p>
                  Ranking combines lexical evidence and deterministic holographic similarity. It
                  does not establish truth.
                </p>
              </details>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {fact.status !== "forgotten" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => toggle({ kind: "fact", factId: fact.id, revision: fact.revision })}
                >
                  {selections.some((item) => item.kind === "fact" && item.factId === fact.id)
                    ? "Remove selection"
                    : "Select"}
                </Button>
              ) : null}
              {fact.status !== "forgotten" ? (
                <>
                  <Button
                    disabled={!canMutate || busy}
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(fact);
                      setContent(fact.content);
                      setEntities(fact.entities.join(", "));
                      setTags(fact.tags.join(", "));
                      setKind(fact.kind);
                      setSources(fact.sources.length ? fact.sources : [{ kind: "user" }]);
                    }}
                  >
                    Edit
                  </Button>
                  {fact.status === "proposed" ? (
                    <Button
                      disabled={!canMutate || busy}
                      size="sm"
                      variant="outline"
                      onClick={() => void revise(fact, "confirm")}
                    >
                      Confirm
                    </Button>
                  ) : null}
                  <Button
                    disabled={!canMutate || busy}
                    size="sm"
                    variant="ghost"
                    onClick={() => void revise(fact, "forget")}
                  >
                    Forget
                  </Button>
                  <Button
                    disabled={!canMutate || busy}
                    size="sm"
                    variant="ghost"
                    onClick={() => void revise(fact, "feedback", true)}
                  >
                    Helpful
                  </Button>
                  <Button
                    disabled={!canMutate || busy}
                    size="sm"
                    variant="ghost"
                    onClick={() => void revise(fact, "feedback", false)}
                  >
                    Unhelpful
                  </Button>
                </>
              ) : null}
            </div>
          </article>
        );
      })}
      {!searchInput && list.data?.nextCursor ? (
        <Button variant="outline" onClick={() => setAfterId(list.data?.nextCursor ?? undefined)}>
          Next facts
        </Button>
      ) : null}
      {afterId ? (
        <Button variant="ghost" onClick={() => setAfterId(undefined)}>
          First facts
        </Button>
      ) : null}
      {search.data?.messages.matches.map((match) =>
        match.messageId && match.digest ? (
          <article key={`${match.threadId}:${match.messageId}`}>
            <p>{match.snippet}</p>
            <Button
              variant="link"
              size="sm"
              onClick={() =>
                setSource({
                  threadId: match.threadId,
                  messageId: match.messageId!,
                  digest: match.digest!,
                })
              }
            >
              Read exact message
            </Button>
          </article>
        ) : null,
      )}
      {searchInput && search.data?.facts.state === "available" && search.data.facts.nextCursor ? (
        <Button
          variant="outline"
          disabled={search.isPending}
          onClick={() => {
            if (search.data?.facts.state === "available" && search.data.facts.nextCursor)
              setSearchInput({
                ...searchInput,
                requestId: CommandId.make(randomUUID()),
                factCursor: search.data.facts.nextCursor,
              });
          }}
        >
          Next fact matches
        </Button>
      ) : null}
      {searchInput && search.data?.messages.nextCursor ? (
        <Button
          variant="outline"
          disabled={search.isPending}
          onClick={() => {
            if (search.data?.messages.nextCursor)
              setSearchInput({ ...searchInput, cursor: search.data.messages.nextCursor });
          }}
        >
          Next conversations
        </Button>
      ) : null}
      {source ? (
        <section className="rounded-md border p-3">
          <h3>Exact source</h3>
          <p className="break-all text-xs">
            {source.threadId}/{source.messageId}
            {source.digest ? ` · sha256:${source.digest}` : null}
          </p>
          {sourceQuery.error ? (
            <p role="alert">{sourceQuery.error}</p>
          ) : sourceQuery.data?.state === "unavailable" ? (
            <p>Source unavailable. {sourceQuery.data.reason}</p>
          ) : sourceQuery.data?.state === "available" ? (
            <>
              <pre className="whitespace-pre-wrap text-sm">{sourceQuery.data.text}</pre>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (sourceQuery.data?.state === "available") toggle(sourceQuery.data.source);
                }}
              >
                Select message
              </Button>
              <Button
                disabled={!canMutate}
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (sourceQuery.data?.state === "available") {
                    setContent(sourceQuery.data.text.slice(0, 12000));
                    setSources([sourceQuery.data.source]);
                    setEditing(null);
                  }
                }}
              >
                Save as fact
              </Button>
            </>
          ) : (
            <p>Reading source…</p>
          )}
        </section>
      ) : null}
      <section>
        <h3>{selections.length} selected</h3>
        {selections.map((selection) => (
          <div className="flex items-center gap-2" key={selectionKey(selection)}>
            <span className="truncate">{selectionKey(selection)}</span>
            <Button variant="ghost" size="sm" onClick={() => toggle(selection)}>
              Remove
            </Button>
          </div>
        ))}
        <div className="flex gap-2">
          <Button disabled={busy || selections.length === 0} onClick={() => void attach()}>
            Preview and attach
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              selectionVersion.current += 1;
              setSelections([]);
              setPreview(null);
              useComposerDraftStore.getState().setKnowledgeContext(target, null);
            }}
          >
            Remove attachment
          </Button>
        </div>
        {preview ? (
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap text-sm">{preview}</pre>
        ) : null}
      </section>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const fields = {
            commandId: CommandId.make(randomUUID()),
            projectId: props.projectId,
            content,
            entities: labels(entities),
            tags: labels(tags),
            kind,
            sources,
          };
          void apply(
            editing
              ? {
                  ...fields,
                  action: "edit",
                  factId: editing.id,
                  expectedRevision: editing.revision,
                }
              : { ...fields, action: "create", factId: ProjectFactId.make(randomUUID()) },
          );
        }}
      >
        <h3>{editing ? "Edit fact" : "Save a fact"}</h3>
        <Textarea
          aria-label="Fact content"
          autoFocus={props.seedMessage !== null}
          value={content}
          maxLength={12000}
          onChange={(event) => setContent(event.target.value)}
          required
        />
        <Input
          aria-label="Entities, comma separated"
          placeholder="Entities, comma separated"
          value={entities}
          onChange={(event) => setEntities(event.target.value)}
        />
        <Input
          aria-label="Tags, comma separated"
          placeholder="Tags, comma separated"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
        />
        <label>
          Kind{" "}
          <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            {["decision", "constraint", "convention", "note"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <p>
          {sources.some((ref) => ref.kind === "message")
            ? "Saved with the selected message citation."
            : "Saved as your assertion."}
        </p>
        {!canMutate ? <p>This environment grants read access only.</p> : null}
        <div className="flex gap-2">
          <Button disabled={!canMutate || busy || content.trim() === ""} type="submit">
            {editing ? "Save edit" : "Save fact"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setEditing(null);
              setContent("");
              setSources([{ kind: "user" }]);
            }}
          >
            New assertion
          </Button>
        </div>
      </form>
    </div>
  );
}
