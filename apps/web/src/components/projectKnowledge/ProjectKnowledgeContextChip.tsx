import { useState } from "react";
import type { ProjectKnowledgeContextRecord } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { BookOpenIcon } from "lucide-react";
import { ContextChip } from "../ContextChip";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { projectKnowledge } from "../../state/projectKnowledge";
import { useAtomCommand } from "../../state/use-atom-command";

export function ProjectKnowledgeContextChip({ record }: { record: ProjectKnowledgeContextRecord }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prepare = useAtomCommand(projectKnowledge.prepareContext, { reportFailure: false });
  const inspect = async () => {
    setPreview(null);
    setError(null);
    setOpen(true);
    const result = await prepare({
      environmentId: record.knowledge.environmentId,
      input: record.knowledge,
    });
    if (result._tag === "Success") setPreview(result.value.text);
    else setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <>
      <ContextChip
        render={<button type="button" />}
        onClick={() => void inspect()}
        aria-label="Inspect selected project knowledge"
      >
        <BookOpenIcon />
        {record.label}
      </ContextChip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogTitle>Selected project knowledge</DialogTitle>
          <DialogDescription>
            Current source material for this reference. Changed or forgotten selections are
            unavailable.
          </DialogDescription>
          {error ? (
            <p role="alert">{error}</p>
          ) : preview === null ? (
            <p>Reading sources…</p>
          ) : (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-sm">{preview}</pre>
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
