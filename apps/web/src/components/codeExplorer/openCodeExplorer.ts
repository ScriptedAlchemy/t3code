import { useAtomSet } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectCodeSymbol,
  ProjectId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

export interface CodeExplorerRequest {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** Where a symbol's file preview opens. */
  readonly threadRef: ScopedThreadRef;
  /** Selects the thread's worktree for queries; a draft has no server thread yet. */
  readonly serverThreadId: ThreadId | null;
  readonly symbol: ProjectCodeSymbol;
}

// Opened from file previews and the command palette, so the open state lives outside both.
// Kept apart from the explorer itself so callers never load its chunk.
export const codeExplorerRequestAtom = Atom.make<
  (CodeExplorerRequest & { readonly key: number }) | null
>(null).pipe(Atom.keepAlive, Atom.withLabel("chat:code-explorer"));

let nextRequestKey = 0;
// Module scope: the React Compiler cannot lower an update of a global inside a hook.
const takeRequestKey = () => ++nextRequestKey;

export function useOpenCodeExplorer() {
  const setRequest = useAtomSet(codeExplorerRequestAtom);
  return (request: CodeExplorerRequest) => setRequest({ ...request, key: takeRequestKey() });
}
