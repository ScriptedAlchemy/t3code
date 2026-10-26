import { Toast } from "@base-ui/react/toast";
import type { ThreadToastData } from "./toast";

type BaseToastManager = ReturnType<typeof Toast.createToastManager<ThreadToastData>>;
type ToastManagerListener = Parameters<BaseToastManager[" subscribe"]>[0];
type ToastManagerEvent = Parameters<ToastManagerListener>[0];

/**
 * base-ui's manager drops events while no provider is subscribed. App services raise toasts
 * from before the first render (and while the root error view replaces the providers), so hold
 * those until a provider listens.
 */
function createBufferedToastManager(): BaseToastManager {
  const manager = Toast.createToastManager<ThreadToastData>();
  const listeners = new Set<ToastManagerListener>();
  const pending: ToastManagerEvent[] = [];
  manager[" subscribe"]((event) => {
    if (listeners.size === 0) {
      pending.push(event);
      return;
    }
    for (const listener of listeners) listener(event);
  });
  return {
    ...manager,
    " subscribe"(listener) {
      listeners.add(listener);
      for (const event of pending.splice(0)) listener(event);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// Keep managers independent of the rendered toast UI so stores can notify without an import cycle.
export const toastManager = createBufferedToastManager();
export const anchoredToastManager = createBufferedToastManager();
