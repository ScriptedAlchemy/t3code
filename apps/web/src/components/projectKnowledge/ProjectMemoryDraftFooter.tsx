import type { KnowledgeSelection } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { selectionKey } from "./projectMemoryLabels";

export const MAX_DRAFT_SELECTIONS = 20;

/** The draft's chosen knowledge. Independent of what the inspector shows. */
export function ProjectMemoryDraftFooter(props: {
  readonly selections: ReadonlyArray<KnowledgeSelection>;
  readonly labelFor: (selection: KnowledgeSelection) => string;
  readonly attached: boolean;
  readonly preview: string | null;
  readonly busy: boolean;
  readonly onRemove: (selection: KnowledgeSelection) => void;
  readonly onClear: () => void;
  readonly onAttach: () => void;
}) {
  const count = props.selections.length;
  return (
    <section
      aria-labelledby="project-memory-draft-selection"
      className="flex shrink-0 flex-col gap-2 border-t bg-muted/72 px-4 py-3 sm:rounded-b-2xl sm:px-6"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-col">
          <h3 id="project-memory-draft-selection" className="font-medium text-sm">
            Draft selection
          </h3>
          <p role="status" className="text-muted-foreground text-xs">
            {count === 0 ? "Nothing selected" : `${count} selected`}
            {count >= MAX_DRAFT_SELECTIONS ? ` (maximum ${MAX_DRAFT_SELECTIONS})` : ""}
            {props.attached ? " · attached to draft" : ""}
          </p>
        </div>
        {count > 0 ? (
          <ul aria-label="Selected for draft" className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {props.selections.map((selection) => {
              const label = props.labelFor(selection);
              return (
                <li
                  key={selectionKey(selection)}
                  className="flex max-w-56 items-center gap-0.5 rounded-md border bg-background ps-2 text-xs"
                >
                  <span className="truncate">{label}</span>
                  <Button
                    aria-label={`Remove ${label} from draft selection`}
                    size="icon-micro"
                    variant="ghost"
                    onClick={() => props.onRemove(selection)}
                  >
                    <XIcon />
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="min-w-0 flex-1 text-muted-foreground text-xs">
            Check a fact or select a message to add it. Inspecting does not select.
          </p>
        )}
        <div className="flex gap-2">
          <Button
            disabled={count === 0 && !props.attached}
            size="sm"
            variant="outline"
            onClick={props.onClear}
          >
            Clear selection
          </Button>
          <Button disabled={props.busy || count === 0} size="sm" onClick={props.onAttach}>
            Preview and attach
          </Button>
        </div>
      </div>
      {props.preview ? (
        <pre
          aria-label="Attached preview"
          className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-2 text-xs"
        >
          {props.preview}
        </pre>
      ) : null}
    </section>
  );
}
