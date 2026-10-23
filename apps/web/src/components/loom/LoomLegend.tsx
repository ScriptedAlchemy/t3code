import { cn } from "~/lib/utils";
import { WEAVE_KIND_ORDER, WEAVE_KINDS } from "./loomKinds";

/** The glyph for each event kind, and the line styles for an exact or inferred placement. */
export function LoomLegend() {
  return (
    <ul
      aria-label="Legend"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 px-3 py-1 text-2xs text-muted-foreground"
    >
      {WEAVE_KIND_ORDER.map((kind) => {
        const Icon = WEAVE_KINDS[kind].icon;
        return (
          <li key={kind} className="flex items-center gap-1">
            <Icon aria-hidden className={cn("size-3", WEAVE_KINDS[kind].text)} />
            {WEAVE_KINDS[kind].label}
          </li>
        );
      })}
      <li className="ms-auto flex items-center gap-1">
        <svg aria-hidden width={20} height={6} className="stroke-foreground/70">
          <line x1={0} x2={20} y1={3} y2={3} strokeWidth={1.5} />
        </svg>
        Exact
      </li>
      <li className="flex items-center gap-1">
        <svg aria-hidden width={20} height={6} className="stroke-foreground/70">
          <line x1={0} x2={20} y1={3} y2={3} strokeWidth={1.5} strokeDasharray="5 4" />
        </svg>
        Inferred
      </li>
    </ul>
  );
}
