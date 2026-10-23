import type { LoomActivityKind } from "@t3tools/contracts";
import {
  BotIcon,
  DiamondIcon,
  FilePenIcon,
  FlaskConicalIcon,
  GitForkIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  ListTodoIcon,
  PlayIcon,
  TerminalIcon,
  TriangleAlertIcon,
  UserIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";

/** Everything the weave can place on a strand: activity ticks plus the window's markers and runs. */
export type WeaveEventKind =
  | LoomActivityKind
  | "run"
  | "checkpoint"
  | "test"
  | "pull_request"
  | "task"
  | "spawn"
  | "rejoin";

interface WeaveKindStyle {
  readonly label: string;
  /** Which kind names a pixel that several share. Higher wins. */
  readonly priority: number;
  readonly icon: LucideIcon;
  /** Tailwind colour utilities for the kind's stroke, fill and text. */
  readonly stroke: string;
  readonly fill: string;
  readonly text: string;
  /** Worth a glyph in the overview, where plain ticks only get dots. */
  readonly significant: boolean;
}

const style = (
  label: string,
  priority: number,
  icon: LucideIcon,
  color: string,
  significant: boolean,
): WeaveKindStyle => ({
  label,
  priority,
  icon,
  stroke: `stroke-${color}`,
  fill: `fill-${color}`,
  text: `text-${color}`,
  significant,
});

// Tailwind only emits classes it can read, so each colour utility is spelled out here:
// stroke-foreground fill-foreground text-foreground stroke-muted-foreground fill-muted-foreground
// text-muted-foreground stroke-info fill-info text-info stroke-success fill-success text-success
// stroke-primary fill-primary text-primary stroke-destructive fill-destructive text-destructive
// stroke-warning fill-warning text-warning
export const WEAVE_KINDS: Record<WeaveEventKind, WeaveKindStyle> = {
  agent: style("Agent", 0, BotIcon, "muted-foreground", false),
  user: style("User", 1, UserIcon, "foreground", false),
  run: style("Run", 2, PlayIcon, "muted-foreground", false),
  tool: style("Tool", 3, WrenchIcon, "primary", false),
  command: style("Command", 4, TerminalIcon, "info", true),
  edit: style("Edit", 5, FilePenIcon, "success", true),
  task: style("Agent task", 6, ListTodoIcon, "primary", true),
  pull_request: style("Pull request", 7, GitPullRequestIcon, "info", true),
  checkpoint: style("Checkpoint", 8, DiamondIcon, "success", true),
  test: style("Test", 9, FlaskConicalIcon, "warning", true),
  error: style("Error", 10, TriangleAlertIcon, "destructive", true),
  spawn: style("Spawn", 11, GitForkIcon, "foreground", true),
  rejoin: style("Rejoin", 12, GitMergeIcon, "foreground", true),
};

/** Legend order: the quiet ticks first, then the events that get glyphs. */
export const WEAVE_KIND_ORDER: ReadonlyArray<WeaveEventKind> = [
  "user",
  "agent",
  "tool",
  "command",
  "edit",
  "test",
  "checkpoint",
  "pull_request",
  "task",
  "error",
  "spawn",
  "rejoin",
];

/** Workstream colours cycle through these; destructive stays reserved for failure. */
export const WORKSTREAM_COLORS = [
  { stroke: "stroke-primary", fill: "fill-primary", text: "text-primary", bg: "bg-primary" },
  { stroke: "stroke-info", fill: "fill-info", text: "text-info", bg: "bg-info" },
  { stroke: "stroke-success", fill: "fill-success", text: "text-success", bg: "bg-success" },
  { stroke: "stroke-warning", fill: "fill-warning", text: "text-warning", bg: "bg-warning" },
] as const;

export const workstreamColor = (index: number) =>
  WORKSTREAM_COLORS[index % WORKSTREAM_COLORS.length]!;
