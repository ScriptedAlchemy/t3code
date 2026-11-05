import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  USAGE_COHORT_MAX_WINDOW_DAYS,
  type EnvironmentId,
  type UsageCohortComparison,
  type UsageCohortReport,
  type UsageCohortSegment,
  type UsageCohortVerdict,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { formatCount, formatDayShort, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

const UNMATCHED_LABELS = {
  no_session_id: "Record has no session id",
  no_attempt_here: "No run on this environment matches the session",
  outside_attempt: "Record falls outside every attempt on its session",
} as const;

const NO_BOUNDARY = "none";
const NO_BOUNDARY_LABEL = "No build comparison";

const segmentLabel = (
  segment: Pick<UsageCohortSegment, "providerInstanceId" | "model" | "speed">,
) =>
  `${segment.providerInstanceId} · ${segment.model}${segment.speed === "standard" ? "" : ` (${segment.speed})`}`;

const ratioText = (ratio: number) => `${ratio.toFixed(2)}x`;

function VerdictCell({ verdict }: { readonly verdict: UsageCohortVerdict }) {
  switch (verdict._tag) {
    case "not_enough_data":
      return (
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">Not enough data</Badge>
          <span className="text-muted-foreground">
            {verdict.reason === "too_few_threads"
              ? "Each side needs at least 30 threads on the same provider, model, and speed."
              : "The range is too wide to call a 15% change."}
            {verdict.threadsPerArmFor15Percent !== null && verdict.daysAtCurrentRate !== null
              ? ` About ${formatCount(verdict.threadsPerArmFor15Percent)} comparable threads per side, ${
                  verdict.daysAtCurrentRate > USAGE_COHORT_MAX_WINDOW_DAYS
                    ? `more than the ${USAGE_COHORT_MAX_WINDOW_DAYS} days this report can cover`
                    : `about ${formatCount(verdict.daysAtCurrentRate)} days at this rate`
                }.`
              : null}
          </span>
        </span>
      );
    case "no_detectable_change":
      return (
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">No detectable change</Badge>
          <span className="text-muted-foreground">
            {ratioText(verdict.ratio)} ({ratioText(verdict.low)} to {ratioText(verdict.high)})
          </span>
        </span>
      );
    case "changed":
      return (
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant="info">Changed</Badge>
          <span className="text-muted-foreground">
            {ratioText(verdict.ratio)} ({ratioText(verdict.low)} to {ratioText(verdict.high)})
          </span>
        </span>
      );
  }
}

function ArmTotals({
  label,
  totals,
}: {
  readonly label: string;
  readonly totals: UsageCohortComparison["base"];
}) {
  return (
    <p>
      <span className="font-medium text-foreground">{label}</span>: {formatCount(totals.threads)}{" "}
      threads, {formatCount(totals.runs)} runs, {formatCount(totals.modelCalls)} calls,{" "}
      {formatTokens(totals.promptTokens)} prompt tokens, {formatUsd(totals.usd)}
    </p>
  );
}

function ComparisonCard({ comparison }: { readonly comparison: UsageCohortComparison }) {
  const { subject } = comparison;
  return (
    <div className="space-y-2 rounded-lg border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium">
          {subject._tag === "experiment" ? subject.label : `Builds around ${subject.boundary}`}
        </h4>
        <Badge variant="outline">Self-selected</Badge>
      </div>
      {subject._tag === "experiment" && subject.spendsOutsideTranscripts ? (
        <p className="text-muted-foreground">
          This setting also makes model calls that provider transcripts do not record, so dollars
          here understate its cost.
        </p>
      ) : null}
      <div className="space-y-0.5 text-muted-foreground">
        <ArmTotals label={comparison.baseLabel} totals={comparison.base} />
        <ArmTotals label={comparison.testLabel} totals={comparison.test} />
        {comparison.threadsSpanningArms > 0 ? (
          <p>
            {formatCount(comparison.threadsSpanningArms)} threads span both sides and are left out.
          </p>
        ) : null}
      </div>
      <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-1">
        <dt>Prompt tokens per call</dt>
        <dd>
          <VerdictCell verdict={comparison.promptTokensPerCall} />
        </dd>
        <dt>Dollars per run</dt>
        <dd>
          <VerdictCell verdict={comparison.usdPerRun} />
        </dd>
      </dl>
      {comparison.segments.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Same provider, model, and speed</TableHead>
              <TableHead>{comparison.baseLabel} tok/call</TableHead>
              <TableHead>{comparison.testLabel} tok/call</TableHead>
              <TableHead>{comparison.baseLabel} $/run</TableHead>
              <TableHead>{comparison.testLabel} $/run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {comparison.segments.map((segment) => (
              <TableRow key={segmentLabel(segment)}>
                <TableCell>{segmentLabel(segment)}</TableCell>
                <TableCell>{perCall(segment.base)}</TableCell>
                <TableCell>{perCall(segment.test)}</TableCell>
                <TableCell>{perRun(segment.base)}</TableCell>
                <TableCell>{perRun(segment.test)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}

const perCall = (totals: UsageCohortComparison["base"]) =>
  totals.modelCalls === 0 ? "none" : formatTokens(totals.promptTokens / totals.modelCalls);
const perRun = (totals: UsageCohortComparison["base"]) =>
  totals.runs === 0 ? "none" : formatUsd(totals.usd / totals.runs);

function Ledger({ ledger }: { readonly ledger: UsageCohortReport["ledger"] }) {
  const unmatchedUsd = ledger.unmatched.reduce((sum, row) => sum + row.usd, 0);
  return (
    <div className="space-y-2 text-xs">
      <dl className="grid grid-cols-[max-content_max-content_1fr] items-baseline gap-x-4 gap-y-1">
        <dt>Total priced</dt>
        <dd className="text-right tabular-nums">{formatUsd(ledger.totalUsd)}</dd>
        <dd />
        <dt>Matched to a run attempt</dt>
        <dd className="text-right tabular-nums">{formatUsd(ledger.attributedUsd)}</dd>
        <dd className="text-muted-foreground">
          {formatUsd(ledger.beforeTrackingUsd)} is from before tracking started
          {ledger.excludedOriginUsd > 0
            ? `, ${formatUsd(ledger.excludedOriginUsd)} from scheduled or server-started runs, left out of comparisons`
            : null}
        </dd>
        <dt>Native subagent work</dt>
        <dd className="text-right tabular-nums">{formatUsd(ledger.childWorkUsd)}</dd>
        <dd className="text-muted-foreground">Owner uncertain, left out of comparisons</dd>
        <dt>Unmatched</dt>
        <dd className="text-right tabular-nums">{formatUsd(unmatchedUsd)}</dd>
        <dd />
      </dl>
      {ledger.unmatched.length > 0 ? (
        <ul className="space-y-0.5 ps-4 text-muted-foreground">
          {ledger.unmatched.map((row) => (
            <li key={`${row.reason}:${row.provider}`}>
              {UNMATCHED_LABELS[row.reason]}, {row.provider}: {formatUsd(row.usd)} (
              {formatCount(row.records)} records)
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-muted-foreground">
        {ledger.stampingSince === null
          ? "No run attempts have been recorded with a build yet."
          : `Builds are recorded from ${formatDayShort(ledger.stampingSince.slice(0, 10))}.`}
        {ledger.incompleteSources > 0
          ? ` ${formatCount(ledger.incompleteSources)} usage sources were incomplete, so totals may be short.`
          : null}
        {ledger.unpricedRecords > 0
          ? ` ${formatCount(ledger.unpricedRecords)} records have no known price.`
          : null}
      </p>
    </div>
  );
}

function BuildsTable({ builds }: { readonly builds: UsageCohortReport["builds"] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Build</TableHead>
          <TableHead>Provider, model, speed</TableHead>
          <TableHead>Threads</TableHead>
          <TableHead>Runs</TableHead>
          <TableHead>Calls</TableHead>
          <TableHead>Prompt tok/call</TableHead>
          <TableHead>Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {builds.flatMap((row) =>
          row.segments.map((segment) => (
            <TableRow key={`${row.build}:${segmentLabel(segment)}`}>
              <TableCell>{row.build ?? "Before tracking"}</TableCell>
              <TableCell>{segmentLabel(segment)}</TableCell>
              <TableCell>{formatCount(segment.threads)}</TableCell>
              <TableCell>{formatCount(segment.runs)}</TableCell>
              <TableCell>{formatCount(segment.modelCalls)}</TableCell>
              <TableCell>{perCall(segment)}</TableCell>
              <TableCell>{formatUsd(segment.usd)}</TableCell>
            </TableRow>
          )),
        )}
      </TableBody>
    </Table>
  );
}

function EnvironmentReport({
  environmentId,
  window,
}: {
  readonly environmentId: EnvironmentId;
  readonly window: UsageSummaryInput;
}) {
  const [boundary, setBoundary] = useState<string | null>(null);
  const reportAtom = serverEnvironment.usageCohortReport({
    environmentId,
    input: {
      sinceDay: window.sinceDay,
      untilDay: window.untilDay,
      timeZone: window.timeZone,
      ...(boundary === null ? {} : { boundaryBuild: boundary }),
    },
  });
  const result = useAtomValue(reportAtom);
  const refresh = useAtomRefresh(reportAtom);
  const report = AsyncResult.getOrElse(result, () => null);
  if (report === null) {
    return result._tag === "Failure" ? (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>This environment could not build the report.</span>
        <Button size="sm" variant="outline" onClick={refresh}>
          Retry
        </Button>
      </div>
    ) : (
      <Skeleton className="h-24 w-full" />
    );
  }
  const builds = report.builds.flatMap((row) => (row.build === null ? [] : [row.build]));
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        This environment, {formatDayShort(report.sinceDay)} to {formatDayShort(report.untilDay)}.
        List-price equivalents, not invoices.
      </p>
      <Ledger ledger={report.ledger} />
      <BuildsTable builds={report.builds} />
      {builds.length > 1 ? (
        <div className="flex items-center gap-2 text-xs">
          <span>Compare builds before</span>
          <Select
            value={boundary ?? NO_BOUNDARY}
            onValueChange={(value) => setBoundary(value === NO_BOUNDARY ? null : value)}
          >
            <SelectTrigger size="sm" aria-label="Build to compare from">
              <SelectValue>{boundary ?? NO_BOUNDARY_LABEL}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={NO_BOUNDARY}>{NO_BOUNDARY_LABEL}</SelectItem>
              {builds.map((build) => (
                <SelectItem key={build} value={build}>
                  {build}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <span>against it and later</span>
        </div>
      ) : null}
      {report.comparisons.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Nobody assigned these sides at random, so a difference can come from who turned a setting
          on or when a build was used. It is not proof of cause.
        </p>
      ) : null}
      {report.comparisons.map((comparison) => (
        <ComparisonCard
          key={
            comparison.subject._tag === "experiment"
              ? comparison.subject.key
              : `build:${comparison.subject.boundary}`
          }
          comparison={comparison}
        />
      ))}
    </div>
  );
}

/** Cost and token burn per build and Labs setting for one environment, loaded when opened. */
export function UsageCohortSection({
  environments,
  window,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly window: UsageSummaryInput;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [open, setOpen] = useState(false);
  const available = environments.filter(
    (environment) =>
      environment.canReadDiagnostics &&
      environment.isConnected &&
      presentations.get(environment.environmentId)?.serverConfig?.environment.capabilities
        .usageCohortReports === 1,
  );
  const [only] = available;
  if (only === undefined) return null;
  return (
    <section className="mt-6 space-y-3">
      <CollapsibleSectionHeader expanded={open} onClick={() => setOpen(!open)} tone="emphasized">
        Cost by build and setting
      </CollapsibleSectionHeader>
      {!open ? null : available.length > 1 ? (
        <p className="text-xs text-muted-foreground">
          Choose one environment above. Each environment reports on its own runs.
        </p>
      ) : (
        <EnvironmentReport environmentId={only.environmentId} window={window} />
      )}
    </section>
  );
}
