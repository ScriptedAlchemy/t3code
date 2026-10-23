import { uuidv4 } from "../lib/uuid";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Switch, View } from "react-native";
import { useAtomValue } from "@effect/atom-react";
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
  type ProjectKnowledgeContextRecord,
  type ProjectKnowledgeMutation,
  type ProjectKnowledgeSearchInput,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import {
  projectKnowledgeComposerReference,
  projectKnowledgeRecordInScope,
  removeProjectKnowledgeReference,
} from "../lib/projectKnowledgeComposer";
import {
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  setComposerDraftText,
  useComposerDraft,
} from "../state/use-composer-drafts";
import { projectKnowledge } from "../state/projectKnowledge";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuery } from "../state/query";
import { AppText, AppTextInput } from "./ui/AppText";
import { Button } from "./ui/Button";
import { Sheet } from "./ui/Sheet";

const selectionKey = (selection: KnowledgeSelection) =>
  selection.kind === "fact"
    ? `fact:${selection.factId}`
    : `message:${selection.threadId}:${selection.messageId}:${selection.digest}`;

const parseLabels = (value: string) =>
  [
    ...new Set(
      value
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ].slice(0, 32);

type Scope = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly draftKey: string;
  readonly disabled: boolean;
};
type MessageCitation = { readonly threadId: ThreadId; readonly messageId: MessageId };
// The digest is optional so a feed message can be cited before the server has
// hashed it; readSource returns the canonical ref.
type SourceRef = MessageCitation & { readonly digest?: KnowledgeMessageRef["digest"] };
type RememberRequest = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly message: MessageCitation;
};

const UNAVAILABLE_SOURCE_LABEL: Record<KnowledgeSourceUnavailableReason, string> = {
  missing: "Source missing",
  deleted: "Source deleted",
  archived: "Source archived",
  wrong_project: "Source moved",
  streaming: "Source still streaming",
  changed: "Source changed",
};

// The feed asks the composer's entry to open, since the sheet writes to that draft.
const rememberListeners = new Set<(request: RememberRequest) => void>();
export function requestRememberMessage(request: RememberRequest): void {
  for (const listener of rememberListeners) listener(request);
}

export function ProjectKnowledgeEntry(props: Scope) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const [open, setOpen] = useState<{ readonly seed: MessageCitation | null } | null>(null);
  const { environmentId, projectId } = props;
  useEffect(() => {
    const listener = (request: RememberRequest) => {
      if (request.environmentId === environmentId && request.projectId === projectId)
        setOpen({ seed: request.message });
    };
    rememberListeners.add(listener);
    return () => {
      rememberListeners.delete(listener);
    };
  }, [environmentId, projectId]);
  if (config?.environment.capabilities.projectKnowledge !== true) return null;
  return (
    <>
      <Button
        label="Project memory"
        icon="brain"
        onPress={() => setOpen({ seed: null })}
        tone="text"
        accessibilityHint="Search and attach evidence from this project"
      />
      {open ? (
        <ProjectKnowledgeSheet
          key={`${props.environmentId}:${props.projectId}:${props.draftKey}:${open.seed?.messageId ?? ""}`}
          {...props}
          seedMessage={open.seed}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

function ProjectKnowledgeSheet(
  props: Scope & { readonly seedMessage: MessageCitation | null; readonly onClose: () => void },
) {
  const scope = { environmentId: props.environmentId, projectId: props.projectId };
  const draft = useComposerDraft(props.draftKey);
  const attached = draft.context?.records.find(
    (record): record is ProjectKnowledgeContextRecord =>
      record.kind === "project-knowledge" && "knowledge" in record,
  );
  const attachedInScope =
    attached?.kind === "project-knowledge" && projectKnowledgeRecordInScope(attached, scope)
      ? attached
      : undefined;
  const [selections, setSelections] = useState<ReadonlyArray<KnowledgeSelection>>(
    attachedInScope?.knowledge.selections ?? [],
  );
  const [status, setStatus] = useState<"confirmed" | "proposed" | "forgotten">("confirmed");
  const [afterId, setAfterId] = useState<ProjectFactId | undefined>();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchInput, setSearchInput] = useState<ProjectKnowledgeSearchInput | null>(null);
  const [source, setSource] = useState<SourceRef | null>(props.seedMessage);
  const [editor, setEditor] = useState<
    { readonly kind: "create" } | { readonly kind: "edit"; readonly fact: ProjectFact } | null
  >(props.seedMessage ? { kind: "create" } : null);
  const [citations, setCitations] = useState<ReadonlyArray<KnowledgeFactSource>>([
    { kind: "user" },
  ]);
  const [prefillPending, setPrefillPending] = useState(props.seedMessage !== null);
  const [content, setContent] = useState("");
  const [entities, setEntities] = useState("");
  const [tags, setTags] = useState("");
  const [kind, setKind] = useState<"decision" | "constraint" | "convention" | "note">("note");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectionVersion = useRef(0);
  useEffect(
    () => () => {
      selectionVersion.current += 1;
    },
    [],
  );
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
    setContent(sourceQuery.data.text.slice(0, 12_000));
    setCitations([sourceQuery.data.source]);
  }
  const mutate = useAtomCommand(projectKnowledge.mutate, { reportFailure: false });
  const prepare = useAtomCommand(projectKnowledge.prepareContext, { reportFailure: false });

  const toggleSelection = (selection: KnowledgeSelection) => {
    selectionVersion.current += 1;
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
            requestId: CommandId.make(uuidv4()),
          },
    );
  const apply = async (input: ProjectKnowledgeMutation) => {
    selectionVersion.current += 1;
    setBusy(true);
    setError(null);
    const result = await mutate({ environmentId: props.environmentId, input });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    setEditor(null);
    setContent("");
    list.refresh();
    restartSearch();
  };

  const revise = (fact: ProjectFact, action: "confirm" | "forget") =>
    apply({
      action,
      commandId: CommandId.make(uuidv4()),
      projectId: props.projectId,
      factId: fact.id,
      expectedRevision: fact.revision,
    });

  const saveFact = () => {
    const fields = {
      content: content.trim(),
      entities: parseLabels(entities),
      tags: parseLabels(tags),
      kind,
    };
    if (editor?.kind === "edit") {
      void apply({
        action: "edit",
        commandId: CommandId.make(uuidv4()),
        projectId: props.projectId,
        factId: editor.fact.id,
        expectedRevision: editor.fact.revision,
        sources: editor.fact.sources.length ? editor.fact.sources : [{ kind: "user" }],
        ...fields,
      });
    } else {
      void apply({
        action: "create",
        commandId: CommandId.make(uuidv4()),
        projectId: props.projectId,
        factId: ProjectFactId.make(uuidv4()),
        sources: citations,
        ...fields,
      });
    }
  };

  const attach = async () => {
    if (props.disabled || selections.length === 0) return;
    const version = ++selectionVersion.current;
    setBusy(true);
    setError(null);
    const result = await prepare({
      environmentId: props.environmentId,
      input: {
        environmentId: props.environmentId,
        projectId: props.projectId,
        selections,
        includeArchived,
        maxBytes: 48_000,
      },
    });
    setBusy(false);
    if (selectionVersion.current !== version) return;
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    if (
      result.value.context.environmentId !== scope.environmentId ||
      result.value.context.projectId !== scope.projectId
    ) {
      setError(
        "The prepared evidence belongs to a different environment or project. Refresh and try again.",
      );
      return;
    }
    const reference = projectKnowledgeComposerReference(result.value.context);
    if (attachedInScope) {
      const current = getComposerDraftSnapshot(props.draftKey);
      setComposerDraftText(
        props.draftKey,
        removeProjectKnowledgeReference(current.text, attachedInScope),
      );
    }
    if (!insertComposerDraftContext(props.draftKey, reference)) {
      setError("Remove a context item before attaching project memory.");
      return;
    }
    props.onClose();
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
    <Sheet title="Project memory" onClose={props.onClose}>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, gap: 14 }}
      >
        <AppText className="text-sm text-foreground-muted">
          {props.projectId} · {props.environmentId}
        </AppText>
        {attached && !attachedInScope ? (
          <View className="gap-2 rounded-2xl bg-subtle p-3">
            <AppText className="text-sm">
              Attached evidence belongs to another project or environment.
            </AppText>
            <Button
              label="Remove mismatched reference"
              tone="secondary"
              onPress={() => {
                selectionVersion.current += 1;
                setSelections([]);
                setComposerDraftText(
                  props.draftKey,
                  removeProjectKnowledgeReference(draft.text, attached),
                );
              }}
            />
          </View>
        ) : attachedInScope ? (
          <View className="gap-2 rounded-2xl bg-subtle p-3">
            <AppText>{attachedInScope.label} is attached to this draft.</AppText>
            <Button
              label="Remove from draft"
              tone="secondary"
              onPress={() => {
                selectionVersion.current += 1;
                setSelections([]);
                setComposerDraftText(
                  props.draftKey,
                  removeProjectKnowledgeReference(draft.text, attachedInScope),
                );
              }}
            />
          </View>
        ) : null}

        <View className="flex-row items-center gap-3">
          <AppText className="flex-1">Include archived conversations</AppText>
          <Switch
            value={includeArchived}
            onValueChange={(value) => {
              selectionVersion.current += 1;
              setIncludeArchived(value);
              setSearchInput(null);
            }}
          />
        </View>
        <View className="flex-row flex-wrap gap-2">
          {(["confirmed", "proposed", "forgotten"] as const).map((value) => (
            <Button
              key={value}
              label={value}
              tone={status === value && !searchInput ? "primary" : "secondary"}
              onPress={() => {
                setStatus(value);
                setAfterId(undefined);
                setSearchInput(null);
              }}
            />
          ))}
          <Button
            label="Refresh"
            tone="text"
            onPress={() => {
              list.refresh();
              restartSearch();
            }}
          />
        </View>
        <View className="gap-2">
          <AppTextInput
            accessibilityLabel="Search project knowledge"
            value={searchText}
            onChangeText={setSearchText}
            placeholder="Search facts and conversations"
            maxLength={200}
            returnKeyType="search"
            onSubmitEditing={() => {
              const query = searchText.trim();
              setSearchInput(
                query.length < 2
                  ? null
                  : {
                      projectId: props.projectId,
                      query,
                      includeArchived,
                      requestId: CommandId.make(uuidv4()),
                    },
              );
            }}
          />
          <Button
            label="Search"
            tone="secondary"
            onPress={() => {
              const query = searchText.trim();
              setSearchInput(
                query.length < 2
                  ? null
                  : {
                      projectId: props.projectId,
                      query,
                      includeArchived,
                      requestId: CommandId.make(uuidv4()),
                    },
              );
            }}
          />
        </View>
        {(error ?? list.error ?? search.error) ? (
          <AppText accessibilityRole="alert" className="text-danger">
            {error ?? list.error ?? search.error}
          </AppText>
        ) : null}
        {list.isPending || search.isPending ? <AppText>Reading project memory…</AppText> : null}
        {search.data?.facts.state === "unavailable" ? (
          <AppText className="text-sm text-foreground-muted">
            Fact ranking is unavailable. Conversation search and saved facts remain available.
          </AppText>
        ) : null}
        {search.data?.facts.state === "available" && search.data.facts.coverage === "partial" ? (
          <AppText className="text-sm text-foreground-muted">
            Partial coverage. Narrow the query to reach more facts.
          </AppText>
        ) : null}

        {!editor ? (
          <Button
            label="Save project fact"
            icon="plus"
            tone="primary"
            disabled={!canMutate || busy}
            onPress={() => {
              setEditor({ kind: "create" });
              setCitations([{ kind: "user" }]);
              setPrefillPending(false);
              setContent("");
              setEntities("");
              setTags("");
              setKind("note");
              setError(null);
            }}
          />
        ) : null}
        {editor ? (
          <View className="gap-3 rounded-2xl bg-subtle p-3">
            <AppText className="font-t3-semibold">
              {editor.kind === "edit" ? "Edit fact" : "New fact"}
            </AppText>
            {editor.kind === "create" && citations.some((ref) => ref.kind === "message") ? (
              <AppText className="text-xs text-foreground-muted">
                Cites the selected message.
              </AppText>
            ) : null}
            <AppTextInput
              accessibilityLabel="Fact content"
              value={content}
              onChangeText={setContent}
              placeholder="A durable project fact"
              multiline
              maxLength={12_000}
              textAlignVertical="top"
              style={{ minHeight: 96 }}
            />
            <AppTextInput
              accessibilityLabel="Entities"
              value={entities}
              onChangeText={setEntities}
              placeholder="Entities, comma separated"
              maxLength={2_048}
            />
            <AppTextInput
              accessibilityLabel="Tags"
              value={tags}
              onChangeText={setTags}
              placeholder="Tags, comma separated"
              maxLength={2_048}
            />
            <View className="flex-row flex-wrap gap-2">
              {(["decision", "constraint", "convention", "note"] as const).map((value) => (
                <Button
                  key={value}
                  label={value}
                  tone={kind === value ? "primary" : "secondary"}
                  onPress={() => setKind(value)}
                />
              ))}
            </View>
            <Button
              label="Save"
              tone="primary"
              disabled={!canMutate || busy || !content.trim()}
              loading={busy}
              onPress={saveFact}
            />
            <Button label="Cancel" tone="text" disabled={busy} onPress={() => setEditor(null)} />
          </View>
        ) : null}

        {facts.map((fact) => (
          <View key={fact.id} className="gap-2 rounded-2xl border border-border p-3">
            {unavailableReasons.has(fact.id) ? (
              <AppText className="text-xs text-warning-foreground">
                {UNAVAILABLE_SOURCE_LABEL[unavailableReasons.get(fact.id)!]}
              </AppText>
            ) : null}
            <AppText className="text-base">{fact.content ?? "Forgotten fact"}</AppText>
            <AppText className="text-xs text-foreground-muted">
              {fact.kind} · {fact.status} · trust {fact.trust.toFixed(2)} · revision {fact.revision}
            </AppText>
            <AppText className="text-xs text-foreground-muted">
              Origin:{" "}
              {fact.origin.kind === "user"
                ? "user assertion"
                : fact.origin.kind === "agent-thread"
                  ? `agent thread ${fact.origin.threadId}`
                  : `agent client ${fact.origin.label}`}
            </AppText>
            <View className="flex-row flex-wrap gap-2">
              {fact.sources.map((ref, index) =>
                ref.kind === "user" ? (
                  <AppText key={`user:${index}`} className="text-sm">
                    User assertion
                  </AppText>
                ) : (
                  <Button
                    key={`${ref.threadId}:${ref.messageId}`}
                    label="Read source"
                    tone="text"
                    onPress={() => setSource(ref)}
                  />
                ),
              )}
              {fact.status !== "forgotten" ? (
                <Button
                  label={
                    selections.some(
                      (selection) => selection.kind === "fact" && selection.factId === fact.id,
                    )
                      ? "Selected"
                      : "Select"
                  }
                  tone="secondary"
                  onPress={() =>
                    toggleSelection({ kind: "fact", factId: fact.id, revision: fact.revision })
                  }
                />
              ) : null}
              {fact.status !== "forgotten" ? (
                <Button
                  label="Edit"
                  tone="text"
                  disabled={!canMutate || busy}
                  onPress={() => {
                    setEditor({ kind: "edit", fact });
                    setContent(fact.content ?? "");
                    setEntities(fact.entities.join(", "));
                    setTags(fact.tags.join(", "));
                    setKind(fact.kind);
                  }}
                />
              ) : null}
              {fact.status === "proposed" ? (
                <Button
                  label="Confirm"
                  tone="secondary"
                  disabled={!canMutate || busy}
                  onPress={() => void revise(fact, "confirm")}
                />
              ) : null}
              {fact.status !== "forgotten" ? (
                <Button
                  label="Forget"
                  tone="danger"
                  disabled={!canMutate || busy}
                  onPress={() => void revise(fact, "forget")}
                />
              ) : null}
            </View>
          </View>
        ))}
        {!searchInput && list.data?.nextCursor ? (
          <Button
            label="Next facts"
            tone="secondary"
            onPress={() => setAfterId(list.data?.nextCursor ?? undefined)}
          />
        ) : null}
        {afterId ? (
          <Button label="First facts" tone="text" onPress={() => setAfterId(undefined)} />
        ) : null}

        {searchInput
          ? search.data?.messages.matches.map((match) =>
              match.messageId && match.digest ? (
                <View
                  key={`${match.threadId}:${match.messageId}`}
                  className="gap-2 rounded-2xl bg-subtle p-3"
                >
                  <AppText>{match.snippet}</AppText>
                  <Button
                    label="Read exact message"
                    tone="text"
                    onPress={() =>
                      setSource({
                        threadId: match.threadId,
                        messageId: match.messageId!,
                        digest: match.digest!,
                      })
                    }
                  />
                  <Button
                    label={
                      selections.some(
                        (selection) =>
                          selection.kind === "message" &&
                          selection.threadId === match.threadId &&
                          selection.messageId === match.messageId,
                      )
                        ? "Selected"
                        : "Select evidence"
                    }
                    tone="secondary"
                    onPress={() =>
                      toggleSelection({
                        kind: "message",
                        threadId: match.threadId,
                        messageId: match.messageId!,
                        digest: match.digest!,
                      })
                    }
                  />
                </View>
              ) : null,
            )
          : null}
        {searchInput && search.data?.facts.state === "available" && search.data.facts.nextCursor ? (
          <Button
            label="Next fact matches"
            tone="secondary"
            disabled={search.isPending}
            onPress={() => {
              if (search.data?.facts.state === "available" && search.data.facts.nextCursor)
                setSearchInput({
                  ...searchInput,
                  requestId: CommandId.make(uuidv4()),
                  factCursor: search.data.facts.nextCursor,
                });
            }}
          />
        ) : null}
        {searchInput && search.data?.messages.nextCursor ? (
          <Button
            label="Next conversations"
            tone="secondary"
            disabled={search.isPending}
            onPress={() => {
              if (search.data?.messages.nextCursor)
                setSearchInput({ ...searchInput, cursor: search.data.messages.nextCursor });
            }}
          />
        ) : null}
        {source ? (
          <View className="gap-2 rounded-2xl bg-subtle p-3">
            <AppText className="font-t3-semibold">Exact source</AppText>
            <AppText className="text-xs text-foreground-muted">
              {source.threadId} / {source.messageId}
            </AppText>
            {sourceQuery.isPending ? <AppText>Reading source…</AppText> : null}
            {sourceQuery.error ? (
              <AppText accessibilityRole="alert" className="text-danger">
                {sourceQuery.error}
              </AppText>
            ) : null}
            {sourceQuery.data?.state === "unavailable" ? (
              <AppText>This message is unavailable ({sourceQuery.data.reason}).</AppText>
            ) : null}
            {sourceQuery.data?.state === "available" ? (
              <>
                <AppText className="text-xs text-foreground-muted">
                  {sourceQuery.data.title} · {sourceQuery.data.role} · {sourceQuery.data.createdAt}
                </AppText>
                <AppText selectable>{sourceQuery.data.text}</AppText>
              </>
            ) : null}
            <Button label="Close source" tone="text" onPress={() => setSource(null)} />
          </View>
        ) : null}

        <View className="gap-2 rounded-2xl border border-border p-3">
          <AppText className="font-t3-semibold">Attach selected evidence</AppText>
          <AppText className="text-sm text-foreground-muted">
            The draft keeps references and revision numbers. Current evidence is reloaded when sent.
          </AppText>
          <AppText className="text-xs text-foreground-muted">
            {selections.length} selected · up to 20
          </AppText>
          <Button
            label="Attach to draft"
            tone="primary"
            disabled={
              props.disabled ||
              busy ||
              selections.length === 0 ||
              Boolean(attached && !attachedInScope)
            }
            loading={busy}
            onPress={() => void attach()}
          />
        </View>
      </ScrollView>
    </Sheet>
  );
}
