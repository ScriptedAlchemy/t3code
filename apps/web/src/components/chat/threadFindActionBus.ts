const THREAD_FIND_OPEN_EVENT = "t3:thread-find-open";

export interface ThreadFindOpenRequest {
  /** `scopedThreadKey` of the thread that should open find. */
  readonly threadKey: string;
  readonly query: string;
  /** Timeline entry to start from; a message entry's id is its message id. */
  readonly entryId?: string;
}

// The target thread view may not be mounted yet when a request names it, for
// example right before navigating there, so it takes the request when it mounts.
let pendingRequest: ThreadFindOpenRequest | null = null;

export function requestThreadFindOpen(request?: ThreadFindOpenRequest): void {
  pendingRequest = request ?? null;
  window.dispatchEvent(new Event(THREAD_FIND_OPEN_EVENT));
}

export function subscribeThreadFindOpen(listener: () => void): () => void {
  window.addEventListener(THREAD_FIND_OPEN_EVENT, listener);
  return () => window.removeEventListener(THREAD_FIND_OPEN_EVENT, listener);
}

export function hasPendingThreadFindOpen(): boolean {
  return pendingRequest !== null;
}

export function takePendingThreadFindOpen(threadKey: string): ThreadFindOpenRequest | null {
  if (pendingRequest?.threadKey !== threadKey) return null;
  const request = pendingRequest;
  pendingRequest = null;
  return request;
}
