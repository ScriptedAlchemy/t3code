import { View } from "react-native";
import type {
  EnvironmentId,
  KnowledgeConflictHint,
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
} from "@t3tools/client-runtime/projectKnowledge";

import { projectKnowledge } from "../state/projectKnowledge";
import { useEnvironmentQuery } from "../state/query";
import { AppText } from "./ui/AppText";
import { Button } from "./ui/Button";

type OpenFact = (factId: ProjectFactId) => void;

const historyTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
// Revision bodies can be 12k characters; the timeline is for orientation, not reading.
const REVISION_PREVIEW_LENGTH = 280;

export function ConflictHintRow(props: {
  readonly hint: KnowledgeConflictHint;
  readonly onOpenFact: OpenFact | null;
}) {
  return (
    <View className="gap-1 rounded-xl bg-subtle p-2">
      <AppText className="text-sm">
        {knowledgeConflictHintLabel(props.hint)}: “{props.hint.excerpt}”
      </AppText>
      {props.onOpenFact ? (
        <Button
          label="Open that fact"
          tone="text"
          onPress={() => props.onOpenFact?.(props.hint.factId)}
        />
      ) : null}
    </View>
  );
}

function SummaryRow(props: {
  readonly label: string;
  readonly summary: ProjectFactSummary;
  readonly onOpenFact: OpenFact;
}) {
  return (
    <View className="gap-1">
      <AppText className="text-sm">
        {props.label}: {props.summary.excerpt ?? "Forgotten fact"} (revision{" "}
        {props.summary.revision}, {props.summary.status})
      </AppText>
      <Button
        label={`Open ${props.label.toLowerCase()}`}
        tone="text"
        onPress={() => props.onOpenFact(props.summary.id)}
      />
    </View>
  );
}

function HistoryRow(props: { readonly entry: ProjectFactHistoryEntry }) {
  const { entry } = props;
  const content =
    (entry.event === "created" || entry.event === "edited") && entry.content !== null
      ? entry.content
      : null;
  return (
    <View className="gap-1 border-l-2 border-border pl-3">
      <AppText className="font-t3-medium">{projectFactHistoryLabel(entry)}</AppText>
      <AppText className="text-xs text-foreground-muted">
        {knowledgeOriginLabel(entry.actor)} · {historyTimeFormatter.format(new Date(entry.at))}
      </AppText>
      {entry.event === "feedback" && entry.trustBefore !== null ? (
        <AppText className="text-xs">
          Trust {entry.trustBefore.toFixed(2)} → {entry.trustAfter.toFixed(2)}
        </AppText>
      ) : null}
      {content !== null ? (
        <AppText className="text-sm" numberOfLines={4}>
          {content.length > REVISION_PREVIEW_LENGTH
            ? `${content.slice(0, REVISION_PREVIEW_LENGTH)}…`
            : content}
        </AppText>
      ) : null}
      {entry.sourceUnavailable !== null ? (
        <AppText className="text-xs text-warning-foreground">
          {KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[entry.sourceUnavailable]}
        </AppText>
      ) : null}
    </View>
  );
}

export function ProjectFactDetailPane(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly factId: ProjectFactId;
  readonly onOpenFact: OpenFact;
  readonly onClose: () => void;
}) {
  const detail = useEnvironmentQuery(
    projectKnowledge.readFact({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, factId: props.factId },
    }),
  );
  // The query keeps the previous fact's data while a linked fact loads.
  const data = detail.data?.fact.id === props.factId ? detail.data : null;
  return (
    <View className="gap-3 rounded-2xl border border-border p-3">
      <View className="flex-row items-center justify-between gap-2">
        <AppText className="font-t3-semibold">Fact details</AppText>
        <Button label="Back to facts" tone="text" onPress={props.onClose} />
      </View>
      {detail.error ? (
        <AppText accessibilityRole="alert" className="text-danger">
          {detail.error}
        </AppText>
      ) : null}
      {data === null && !detail.error ? <AppText>Reading fact history…</AppText> : null}
      {data ? (
        <>
          <AppText selectable>{data.fact.content ?? "Forgotten fact"}</AppText>
          <AppText className="text-xs text-foreground-muted">
            {data.fact.kind} · {data.fact.status} · trust {data.fact.trust.toFixed(2)} · revision{" "}
            {data.fact.revision}
          </AppText>
          {data.sourceUnavailable !== null ? (
            <AppText className="text-xs text-warning-foreground">
              {KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[data.sourceUnavailable]}
            </AppText>
          ) : null}
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
            <ConflictHintRow key={hint.factId} hint={hint} onOpenFact={props.onOpenFact} />
          ))}
          <AppText className="text-sm font-t3-medium">History</AppText>
          {data.historyTruncated ? (
            <AppText className="text-xs text-foreground-muted">Earlier history not shown</AppText>
          ) : null}
          <View className="gap-3">
            {data.history.map((entry) => (
              <HistoryRow key={entry.sequence} entry={entry} />
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

export function KnowledgeHealthRow(props: {
  readonly status: ProjectKnowledgeStatus;
  readonly onShowUnavailable: () => void;
}) {
  const { status } = props;
  const lost = status.unavailableSources;
  return (
    <View className="gap-1">
      <AppText className="text-xs text-foreground-muted">
        {status.counts.confirmed} confirmed · {status.counts.proposed} proposed ·{" "}
        {status.counts.superseded} superseded · {status.belowRecallThreshold} below recall ·{" "}
        {status.feedback.helpful} helpful · {status.feedback.unhelpful} unhelpful
      </AppText>
      {lost > 0 ? (
        <Button
          label={`${status.unavailableSourcesCoverage === "partial" ? "At least " : ""}${
            lost === 1 ? "1 fact lost its source" : `${lost} facts lost their source`
          }`}
          tone="text"
          onPress={props.onShowUnavailable}
        />
      ) : null}
    </View>
  );
}
