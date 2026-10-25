import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type ConversationSummary,
  type ConversationSummaryId,
  type ConversationSummaryRead,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { conversationSummaryPassLabel } from "@t3tools/client-runtime/conversationSummaries";
import { KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL } from "@t3tools/client-runtime/projectKnowledge";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useState } from "react";

import { conversationSummaries } from "../../state/conversationSummaries";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Switch } from "../ui/switch";

const PAGE_SIZE = 20;
const SOURCE_PAGE_SIZE = 6;

interface Scope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}

/** The project opt-in. Summaries cost model calls, so it starts off. */
function SummariesToggle(props: Scope) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = config?.settings;
  if (!settings || config.environment.capabilities.projectSettingsOverrides !== true) return null;
  const enabled = resolveProjectSettings(settings, props.projectId).settings
    .enableConversationSummaries;
  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId: props.environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [props.projectId]: {
              ...settings.projectSettingsOverrides[props.projectId],
              enableConversationSummaries: next,
            },
          },
        },
      },
    });
    setBusy(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <section
      aria-label="Summarize older messages"
      className="flex flex-col gap-1 rounded-md border p-3"
    >
      <div className="flex items-center justify-between gap-3 font-medium text-sm">
        <span>Summarize older messages</span>
        <Switch
          aria-label="Summarize older messages"
          checked={enabled}
          disabled={!canWrite || busy}
          onCheckedChange={(checked) => void toggle(checked)}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        After turns complete in this project, your text generation model summarizes settled
        stretches of up to 24 older messages. Each summary costs one model call.
      </p>
      {!canWrite ? (
        <p className="text-xs">This connection cannot change project settings.</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function SummarySources(props: Scope & { readonly summaryId: ConversationSummaryId }) {
  const [limit, setLimit] = useState(SOURCE_PAGE_SIZE);
  const expansion = useEnvironmentQuery(
    conversationSummaries.expand({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        threadId: props.threadId,
        summaryId: props.summaryId,
        limit,
      },
    }),
  );
  if (expansion.error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {expansion.error}
      </p>
    );
  if (!expansion.data) return <p className="text-muted-foreground text-sm">Loading messages…</p>;
  return (
    <ol className="flex flex-col gap-2">
      {expansion.data.sources.map(({ ref, result }, index) => (
        <li key={ref.messageId} className="rounded-md border p-2 text-sm">
          <p className="text-muted-foreground text-xs">
            #{index + 1} ·{" "}
            {result.state === "available"
              ? result.role === "user"
                ? "User"
                : "Assistant"
              : "Unavailable"}
          </p>
          {result.state === "available" ? (
            <p className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap">{result.text}</p>
          ) : (
            <p className="mt-1 text-muted-foreground">
              {KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[result.reason]}.
            </p>
          )}
        </li>
      ))}
      {expansion.data.nextOffset !== null ? (
        <li>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLimit((current) => Math.min(24, current + SOURCE_PAGE_SIZE))}
          >
            Show more messages
          </Button>
        </li>
      ) : null}
    </ol>
  );
}

function SummaryStatements(props: { readonly summary: ConversationSummary }) {
  const position = new Map(
    props.summary.sources.map((source, index) => [source.messageId, index + 1]),
  );
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {props.summary.statements.map((statement) => (
        <li key={statement.text}>
          {statement.text}{" "}
          <span className="text-muted-foreground text-xs">
            [{statement.citations.map((id) => `#${position.get(id)}`).join(", ")}]
          </span>
        </li>
      ))}
    </ul>
  );
}

function SummaryCard(props: Scope & { readonly read: ConversationSummaryRead }) {
  const [showSources, setShowSources] = useState(false);
  const id = props.read.state === "available" ? props.read.summary.id : props.read.id;
  const sourceCount =
    props.read.state === "available" ? props.read.summary.sources.length : props.read.sourceCount;
  const createdAt =
    props.read.state === "available" ? props.read.summary.createdAt : props.read.createdAt;
  return (
    <article className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-muted-foreground text-xs">
        {sourceCount} messages · written {new Date(createdAt).toLocaleString()}
      </p>
      {props.read.state === "available" ? (
        <SummaryStatements summary={props.read.summary} />
      ) : (
        <p className="text-sm">
          Outdated: {KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[props.read.reason].toLowerCase()}. The
          summary text is hidden and agents no longer receive it.
        </p>
      )}
      <div>
        <Button variant="ghost" size="sm" onClick={() => setShowSources((value) => !value)}>
          {showSources ? "Hide source messages" : "Show source messages"}
        </Button>
      </div>
      {showSources ? <SummarySources {...props} summaryId={id} /> : null}
    </article>
  );
}

function SummaryList(props: Scope) {
  const [cursors, setCursors] = useState<ReadonlyArray<ConversationSummaryId>>([]);
  const list = useEnvironmentQuery(
    conversationSummaries.list({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        threadId: props.threadId,
        limit: PAGE_SIZE,
        ...(cursors.at(-1) === undefined ? {} : { cursor: cursors.at(-1)! }),
      },
    }),
  );
  if (list.error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {list.error}
      </p>
    );
  if (!list.data) return <p className="text-muted-foreground text-sm">Loading summaries…</p>;
  const { lastPass, summaries, nextCursor, enabled } = list.data;
  return (
    <div className="flex flex-col gap-3">
      {lastPass ? (
        <p className="text-muted-foreground text-xs">{conversationSummaryPassLabel(lastPass)}</p>
      ) : enabled ? (
        <p className="text-muted-foreground text-xs">
          The first summary is written after a turn completes and enough older messages have
          settled.
        </p>
      ) : null}
      {summaries.length === 0 ? (
        <p className="text-muted-foreground text-sm">This thread has no summaries yet.</p>
      ) : (
        summaries.map((read) => (
          <SummaryCard
            key={read.state === "available" ? read.summary.id : read.id}
            {...props}
            read={read}
          />
        ))
      )}
      {cursors.length > 0 || nextCursor !== null ? (
        <div className="flex justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={cursors.length === 0}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            Earlier
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={nextCursor === null}
            onClick={() => {
              if (nextCursor !== null) setCursors((current) => [...current, nextCursor]);
            }}
          >
            Later
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ConversationSummariesDialog(
  props: Scope & { readonly open: boolean; readonly onOpenChange: (open: boolean) => void },
) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Conversation summaries</DialogTitle>
          <DialogDescription>
            Model-written summaries of this thread's older messages. When the thread moves to
            another provider or is forked, agents receive them in place of messages that no longer
            fit, and can open the exact messages behind each one.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <SummariesToggle {...props} />
            {props.open ? <SummaryList {...props} /> : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
