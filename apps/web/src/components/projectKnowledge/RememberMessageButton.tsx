import type { MessageId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { BrainIcon } from "lucide-react";
import { useThreadShell } from "../../state/entities";
import { projectKnowledge } from "../../state/projectKnowledge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useOpenProjectMemory, useProjectMemoryAvailable } from "./ProjectMemoryPanel";

export function RememberMessageButton(props: {
  readonly threadRef: ScopedThreadRef | null;
  // Projected rows can show a message owned by another thread, such as a subagent.
  readonly sourceThreadId?: ThreadId | undefined;
  readonly messageId: MessageId;
}) {
  const thread = useThreadShell(props.threadRef);
  const environmentId = props.threadRef?.environmentId ?? null;
  const available = useProjectMemoryAvailable(environmentId);
  const canMutate = useAtomValue(projectKnowledge.mutate.permissionAtom(environmentId));
  const open = useOpenProjectMemory();
  if (!available || !canMutate || !thread?.projectId || !props.threadRef) return null;
  const { projectId } = thread;
  const { environmentId: env, threadId } = props.threadRef;
  const label = "Remember for this project";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={label}
            onClick={() =>
              open({
                environmentId: env,
                projectId,
                message: { threadId: props.sourceThreadId ?? threadId, messageId: props.messageId },
              })
            }
          />
        }
      >
        <BrainIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
