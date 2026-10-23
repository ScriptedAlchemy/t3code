import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import { projectKnowledge } from "../state/projectKnowledge";
import { serverEnvironment } from "../state/server";
import { environmentThreadShells } from "../state/threads";
import { requestRememberMessage } from "./ProjectKnowledgeEntry";

/** Returns a "Remember for this project" action, or null when this thread cannot save facts. */
export function useRememberMessage(environmentId: EnvironmentId, threadId: ThreadId) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canMutate = useAtomValue(projectKnowledge.mutate.permissionAtom(environmentId));
  const thread = useAtomValue(
    environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId)),
  );
  const projectId = thread?.projectId;
  if (config?.environment.capabilities.projectKnowledge !== true || !canMutate || !projectId)
    return null;
  return (message: { readonly threadId: ThreadId; readonly messageId: MessageId }) =>
    requestRememberMessage({ environmentId, projectId, message });
}
