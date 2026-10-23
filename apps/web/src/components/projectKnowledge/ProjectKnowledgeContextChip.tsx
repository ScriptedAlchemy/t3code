import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { MessageId, ProjectKnowledgeContextRecord, ThreadId } from "@t3tools/contracts";
import {
  deliveredKnowledgeNotes,
  deliveredKnowledgeSnapshot,
  KNOWLEDGE_DELIVERY_OMISSION_LABEL,
} from "@t3tools/client-runtime/projectKnowledge";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { BookOpenIcon } from "lucide-react";
import { ContextChip } from "../ContextChip";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { projectKnowledge } from "../../state/projectKnowledge";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * In the composer this previews the current sources. On a sent message (`sent` given) it shows
 * the recorded copy of what the turn delivered, never a fresh read that may have changed since.
 */
export function ProjectKnowledgeContextChip({
  record,
  sent,
}: {
  record: ProjectKnowledgeContextRecord;
  sent?: { readonly threadId: ThreadId; readonly messageId: MessageId } | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prepare = useAtomCommand(projectKnowledge.prepareContext, { reportFailure: false });
  const inspect = async () => {
    setPreview(null);
    setError(null);
    setOpen(true);
    if (sent) return;
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
          {sent ? (
            open ? (
              <DeliveredKnowledge record={record} sent={sent} />
            ) : null
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Selected project knowledge</DialogTitle>
                <DialogDescription>
                  Current source material for this reference. Changed or forgotten selections are
                  unavailable.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                {error ? (
                  <p role="alert">{error}</p>
                ) : preview === null ? (
                  <p>Reading sources…</p>
                ) : (
                  <pre className="whitespace-pre-wrap text-sm">{preview}</pre>
                )}
              </DialogPanel>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}

function DeliveredKnowledge({
  record,
  sent,
}: {
  record: ProjectKnowledgeContextRecord;
  sent: { readonly threadId: ThreadId; readonly messageId: MessageId };
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(record.knowledge.environmentId));
  const supportsDeliveries = config?.environment?.capabilities.projectKnowledgeDeliveries === true;
  const query = useEnvironmentQuery(
    supportsDeliveries
      ? projectKnowledge.readDeliveries({
          environmentId: record.knowledge.environmentId,
          input: { projectId: record.knowledge.projectId, ...sent },
        })
      : null,
  );
  const snapshot = query.data ? deliveredKnowledgeSnapshot(query.data, record.contextId) : null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Project knowledge as sent</DialogTitle>
        <DialogDescription>
          The copy T3 delivered with this message. It does not show whether the agent used it.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {!supportsDeliveries ? (
          <p>This server can't show what was sent</p>
        ) : query.error ? (
          <p role="alert">{query.error}</p>
        ) : query.data === null ? (
          <p>Reading delivery record…</p>
        ) : snapshot === null ? (
          <p>No delivery was recorded for this reference.</p>
        ) : (
          <>
            {deliveredKnowledgeNotes(snapshot).map((note) => (
              <p key={note} className="text-muted-foreground text-sm">
                {note}
              </p>
            ))}
            {snapshot.omission ? (
              <p className="text-sm">
                Not sent: {KNOWLEDGE_DELIVERY_OMISSION_LABEL[snapshot.omission.reason]}
              </p>
            ) : snapshot.item.contentRemoved ? null : (
              <pre className="whitespace-pre-wrap text-sm">{snapshot.item.text}</pre>
            )}
          </>
        )}
      </DialogPanel>
    </>
  );
}
