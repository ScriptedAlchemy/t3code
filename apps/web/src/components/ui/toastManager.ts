import { Toast } from "@base-ui/react/toast";
import type { ThreadToastData } from "./toast";

// Keep managers independent of the rendered toast UI so stores can notify without an import cycle.
export const toastManager = Toast.createToastManager<ThreadToastData>();
export const anchoredToastManager = Toast.createToastManager<ThreadToastData>();
