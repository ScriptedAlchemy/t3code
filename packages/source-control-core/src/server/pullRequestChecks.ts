import * as NodeUtil from "node:util";
import type { PullRequestCheck, PullRequestCheckFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const zonedDateTimePattern =
  /^(?:\d{4}|[+-]\d{6})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?|24:00(?::00(?:\.0+)?)?)(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;

// Parse whole seconds separately so sub-millisecond fractions keep their precision.
function timestampParts(value: string) {
  if (!zonedDateTimePattern.test(value)) return { time: Number.NaN, fraction: "" };
  const fraction = /\.(\d+)(?=Z$|[+-]\d{2}:\d{2}$)/i.exec(value);
  // Date can normalize impossible days. Check the calendar date before applying the offset.
  const datePart = value.split(/[Tt]/, 1)[0] ?? "";
  const date = DateTime.make(`${datePart}T00:00:00Z`);
  const parts = Option.isSome(date) ? DateTime.toPartsUtc(date.value) : null;
  const validDate =
    parts !== null &&
    parts.month === Number(datePart.slice(-5, -3)) &&
    parts.day === Number(datePart.slice(-2));
  return {
    time: validDate ? Date.parse(fraction ? value.replace(fraction[0], "") : value) : Number.NaN,
    fraction: fraction?.[1] ?? "",
  };
}

function isAtLeastAsNew(candidate: string | null, kept: string | null): boolean {
  if (candidate === null) return kept === null;
  if (kept === null) return true;
  const candidateParts = timestampParts(candidate);
  const keptParts = timestampParts(kept);
  if (Number.isNaN(candidateParts.time) || Number.isNaN(keptParts.time)) return candidate >= kept;
  if (candidateParts.time !== keptParts.time) return candidateParts.time > keptParts.time;
  const precision = Math.max(candidateParts.fraction.length, keptParts.fraction.length);
  return (
    candidateParts.fraction.padEnd(precision, "0") >= keptParts.fraction.padEnd(precision, "0")
  );
}

/** action-required is a finished check needing human input. */
export const isFailedCheck = (check: Pick<PullRequestCheck, "status">) =>
  check.status === "failure" || check.status === "cancelled" || check.status === "action-required";

export function sortChecks(
  checks: ReadonlyArray<PullRequestCheck>,
): ReadonlyArray<PullRequestCheck> {
  return checks.toSorted(
    (a, b) =>
      Number(b.status === "failure" || b.status === "cancelled") -
      Number(a.status === "failure" || a.status === "cancelled"),
  );
}

/**
 * Rollups repeat checks during reruns or overlapping runs, each with its own handle.
 * Identify checks by workflow plus name because different workflows may share job names.
 */
export function dedupeChecks(
  entries: ReadonlyArray<{
    readonly check: PullRequestCheck;
    readonly workflowName: string | null;
    readonly at: string | null;
  }>,
): ReadonlyArray<PullRequestCheck> {
  const newestByCheck = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.workflowName ?? "", entry.check.name]);
    const kept = newestByCheck.get(key);
    if (kept === undefined || isAtLeastAsNew(entry.at, kept.at)) newestByCheck.set(key, entry);
  }
  const survivors = [...newestByCheck.values()];
  const countsByName = new Map<string, number>();
  for (const entry of survivors) {
    countsByName.set(entry.check.name, (countsByName.get(entry.check.name) ?? 0) + 1);
  }
  return sortChecks(
    survivors.map((entry) => {
      const workflowName = entry.workflowName ?? "";
      return workflowName.length > 0 && (countsByName.get(entry.check.name) ?? 0) > 1
        ? { ...entry.check, name: `${workflowName} / ${entry.check.name}` }
        : entry.check;
    }),
  );
}

export const CHECK_LOG_EXCERPT_BUDGET = {
  maxLines: 80,
  maxBytes: 8192,
  context: 3,
  tail: 20,
} as const;
type Line = { index: number; text: string };

export class CheckLogExcerpt {
  private pending = "";
  private totalLines = 0;
  private clipped = false;
  private afterError = 0;
  private header: Line | undefined;
  private tail: Line[] = [];
  private failedTail: Line[] = [];
  private failedSection = false;
  private selected = new Map<number, Line>();

  private readonly failedSteps: ReadonlyArray<string>;

  constructor(failedSteps: ReadonlyArray<string> = []) {
    this.failedSteps = failedSteps;
  }

  write(chunk: string): void {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf("\n", start);
      const part = chunk.slice(start, end < 0 ? undefined : end);
      const room = CHECK_LOG_EXCERPT_BUDGET.maxBytes - this.pending.length;
      this.pending += part.slice(0, room);
      if (part.length > room) this.clipped = true;
      if (end < 0) break;
      this.line(this.pending);
      this.pending = "";
      start = end + 1;
    }
  }

  private line(raw: string): void {
    const line = {
      index: this.totalLines++,
      text: NodeUtil.stripVTControlCharacters(raw)
        .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "")
        .replace(/\r$/, ""),
    };
    if (line.text.startsWith("##[group]Run ")) {
      if (this.failedSection) this.failedTail = this.tail;
      this.tail = [];
      this.header = line;
      this.failedSection = this.failedSteps.includes(line.text.slice("##[group]".length));
      if (this.failedSection) this.selected.set(line.index, line);
    }
    if (line.text.includes("##[error]")) {
      this.failedSection = true;
      if (this.header) this.selected.set(this.header.index, this.header);
      for (const prior of this.tail.slice(-CHECK_LOG_EXCERPT_BUDGET.context))
        this.selected.set(prior.index, prior);
      this.afterError = CHECK_LOG_EXCERPT_BUDGET.context + 1;
    }
    if (this.afterError > 0) {
      this.selected.set(line.index, line);
      this.afterError--;
    }
    while (this.selected.size > CHECK_LOG_EXCERPT_BUDGET.maxLines) {
      this.selected.delete(this.selected.keys().next().value!);
    }
    this.tail.push(line);
    if (this.tail.length > CHECK_LOG_EXCERPT_BUDGET.tail) this.tail.shift();
  }

  finish(): Extract<PullRequestCheckFailure["log"], { _tag: "excerpt" }> {
    if (this.pending.length > 0) {
      this.line(this.pending);
      this.pending = "";
    }
    const selected = new Map(this.selected);
    const tail = this.failedSection || this.failedTail.length === 0 ? this.tail : this.failedTail;
    for (const line of tail) selected.set(line.index, line);
    const lines = [...selected.values()]
      .sort((a, b) => a.index - b.index)
      .slice(-CHECK_LOG_EXCERPT_BUDGET.maxLines);
    const kept: string[] = [];
    let bytes = 0;
    for (const line of lines.toReversed()) {
      const room = CHECK_LOG_EXCERPT_BUDGET.maxBytes - bytes - (kept.length > 0 ? 1 : 0);
      if (room <= 0) break;
      let text = line.text;
      if (Buffer.byteLength(text) > room) {
        text = new TextDecoder("utf-8", { fatal: false }).decode(
          Buffer.from(text).subarray(0, room),
        );
        while (Buffer.byteLength(text) > room) text = text.slice(0, -1);
        this.clipped = true;
      }
      bytes += Buffer.byteLength(text) + (kept.length > 0 ? 1 : 0);
      kept.push(text);
    }
    return {
      _tag: "excerpt",
      text: kept.reverse().join("\n"),
      totalLines: this.totalLines,
      truncated: this.clipped || kept.length < this.totalLines,
    };
  }
}

export function excerptCheckLog(chunks: Iterable<string>, failedSteps: ReadonlyArray<string> = []) {
  const excerpt = new CheckLogExcerpt(failedSteps);
  for (const chunk of chunks) excerpt.write(chunk);
  return excerpt.finish();
}
