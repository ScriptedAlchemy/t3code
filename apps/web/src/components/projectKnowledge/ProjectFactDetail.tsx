import { useState } from "react";
import type {
  EnvironmentId,
  KnowledgeConflictHint,
  KnowledgeMessageRef,
  ProjectFactHistoryEntry,
  ProjectFactId,
  ProjectFactSummary,
  ProjectId,
  ProjectKnowledgeStatus,
} from "@t3tools/contracts";
import {
  KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL,
  knowledgeConflictHintLabel,
  knowledgeOriginLabel,
  projectFactHistoryLabel,
  projectFactTrustPoints,
} from "@t3tools/client-runtime/projectKnowledge";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useEnvironmentQuery } from "../../state/query";
import { projectKnowledge } from "../../state/projectKnowledge";

type OpenFact = (factId: ProjectFactId) => void;

const historyTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 24;

// Trust lives in [0, 1]; a fixed scale keeps a flat history visibly flat instead of
// stretching noise across the full height.
function TrustSparkline(props: { readonly points: ReadonlyArray<number> }) {
  const first = props.points[0] ?? 0;
  const last = props.points.at(-1) ?? 0;
  const step = SPARK_WIDTH / (props.points.length - 1);
  const coordinates = props.points
    .map((point, index) => {
      const clamped = Math.min(1, Math.max(0, point));
      return `${(index * step).toFixed(1)},${(SPARK_HEIGHT - clamped * SPARK_HEIGHT).toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      role="img"
      aria-label={`Trust from ${first.toFixed(2)} to ${last.toFixed(2)}`}
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      className="overflow-visible text-muted-foreground"
    >
      <polyline points={coordinates} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

/** Lexical hint shown with the fact it was computed against; compare is local and transient. */
export function ConflictHintRow(props: {
  readonly hint: KnowledgeConflictHint;
  readonly currentContent: string | null;
  readonly onOpenFact: OpenFact | null;
}) {
  const [comparing, setComparing] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <p>
        {knowledgeConflictHintLabel(props.hint)}: <q>{props.hint.excerpt}</q>
      </p>
      <div className="flex flex-wrap gap-2">
        {props.onOpenFact ? (
          <Button variant="link" size="sm" onClick={() => props.onOpenFact?.(props.hint.factId)}>
            Open that fact
          </Button>
        ) : null}
        {props.currentContent !== null ? (
          <Button variant="ghost" size="sm" onClick={() => setComparing((value) => !value)}>
            {comparing ? "Hide comparison" : "Compare"}
          </Button>
        ) : null}
      </div>
      {comparing && props.currentContent !== null ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <figure className="rounded-md border p-2">
            <figcaption className="text-xs text-muted-foreground">This fact</figcaption>
            <p className="whitespace-pre-wrap text-sm">{props.currentContent}</p>
          </figure>
          <figure className="rounded-md border p-2">
            <figcaption className="text-xs text-muted-foreground">
              Existing fact, revision {props.hint.revision}
            </figcaption>
            <p className="whitespace-pre-wrap text-sm">{props.hint.excerpt}</p>
          </figure>
        </div>
      ) : null}
    </div>
  );
}

function SummaryRow(props: {
  readonly label: string;
  readonly summary: ProjectFactSummary;
  readonly onOpenFact: OpenFact;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span>
        {props.label}: {props.summary.excerpt ?? "Forgotten fact"} (revision{" "}
        {props.summary.revision}, {props.summary.status})
      </span>
      <Button variant="link" size="sm" onClick={() => props.onOpenFact(props.summary.id)}>
        Open
      </Button>
    </div>
  );
}

function HistoryRow(props: {
  readonly entry: ProjectFactHistoryEntry;
  readonly onOpenSource: (source: KnowledgeMessageRef) => void;
}) {
  const { entry } = props;
  const showsContent =
    (entry.event === "created" || entry.event === "edited") && entry.content !== null;
  return (
    <li className="flex flex-col gap-1 border-l-2 pl-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{projectFactHistoryLabel(entry)}</span>
        <span className="text-xs text-muted-foreground">
          {knowledgeOriginLabel(entry.actor)} ·{" "}
          <time dateTime={entry.at}>{historyTimeFormatter.format(new Date(entry.at))}</time>
        </span>
      </div>
      {entry.event === "feedback" && entry.trustBefore !== null ? (
        <p className="text-xs">
          Trust {entry.trustBefore.toFixed(2)} → {entry.trustAfter.toFixed(2)}
        </p>
      ) : null}
      {showsContent ? (
        <details>
          <summary className="text-xs">Revision {entry.revision} content</summary>
          <p className="whitespace-pre-wrap text-sm">{entry.content}</p>
        </details>
      ) : null}
      {entry.sources.some((source) => source.kind === "message") ||
      entry.sourceUnavailable !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          {entry.sources.map((source) =>
            source.kind === "message" ? (
              <Button
                key={`${source.threadId}:${source.messageId}`}
                variant="link"
                size="sm"
                onClick={() => props.onOpenSource(source)}
              >
                Message {source.messageId}
              </Button>
            ) : null,
          )}
          {entry.sourceUnavailable !== null ? (
            <Badge variant="warning">
              {KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[entry.sourceUnavailable]}
            </Badge>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function ProjectFactDetailPane(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly factId: ProjectFactId;
  readonly onOpenFact: OpenFact;
  readonly onOpenSource: (source: KnowledgeMessageRef) => void;
  readonly onClose: () => void;
}) {
  const detail = useEnvironmentQuery(
    projectKnowledge.readFact({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, factId: props.factId },
    }),
  );
  const data = detail.data?.fact.id === props.factId ? detail.data : null;
  const trust = data ? projectFactTrustPoints(data.history) : [];
  return (
    <section aria-label="Fact details" className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">Fact details</h3>
        <Button variant="ghost" size="sm" onClick={props.onClose}>
          Back to facts
        </Button>
      </div>
      {detail.error ? <p role="alert">{detail.error}</p> : null}
      {data === null && !detail.error ? <p>Reading fact history…</p> : null}
      {data ? (
        <>
          <p className="whitespace-pre-wrap">{data.fact.content ?? "Forgotten fact"}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              {data.fact.kind} · {data.fact.status} · trust {data.fact.trust.toFixed(2)} · revision{" "}
              {data.fact.revision}
            </span>
            {data.sourceUnavailable !== null ? (
              <Badge variant="warning">
                {KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[data.sourceUnavailable]}
              </Badge>
            ) : null}
            {trust.length >= 2 ? <TrustSparkline points={trust} /> : null}
          </div>
          {data.supersedes ? (
            <SummaryRow
              label="Supersedes"
              summary={data.supersedes}
              onOpenFact={props.onOpenFact}
            />
          ) : null}
          {data.supersededBy ? (
            <SummaryRow
              label="Superseded by"
              summary={data.supersededBy}
              onOpenFact={props.onOpenFact}
            />
          ) : null}
          {data.hints.map((hint) => (
            <ConflictHintRow
              key={hint.factId}
              hint={hint}
              currentContent={data.fact.content}
              onOpenFact={props.onOpenFact}
            />
          ))}
          <h4 className="text-sm font-medium">History</h4>
          {data.historyTruncated ? (
            <p className="text-xs text-muted-foreground">Earlier history not shown</p>
          ) : null}
          <ol aria-label="Fact history" className="flex flex-col gap-2">
            {data.history.map((entry) => (
              <HistoryRow key={entry.sequence} entry={entry} onOpenSource={props.onOpenSource} />
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}

export function KnowledgeHealthStrip(props: {
  readonly status: ProjectKnowledgeStatus;
  readonly onShowUnavailable: () => void;
}) {
  const { status } = props;
  const lost = status.unavailableSources;
  const counters = [
    ["Confirmed", status.counts.confirmed],
    ["Proposed", status.counts.proposed],
    ["Superseded", status.counts.superseded],
    ["Below recall threshold", status.belowRecallThreshold],
    ["Retrievals", status.retrievals],
    ["Helpful", status.feedback.helpful],
    ["Unhelpful", status.feedback.unhelpful],
  ] as const;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <dl aria-label="Memory health" className="flex flex-wrap gap-x-3 gap-y-1">
        {counters.map(([label, value]) => (
          <div key={label} className="flex gap-1">
            <dt>{label}</dt>
            <dd className="tabular-nums text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      {lost > 0 ? (
        <Button variant="link" size="sm" onClick={props.onShowUnavailable}>
          {status.unavailableSourcesCoverage === "partial" ? "At least " : ""}
          {lost === 1 ? "1 fact lost its source" : `${lost} facts lost their source`}
        </Button>
      ) : null}
    </div>
  );
}
