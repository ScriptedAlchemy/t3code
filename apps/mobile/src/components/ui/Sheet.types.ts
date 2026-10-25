import type { ReactNode } from "react";

export interface SheetProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  /** Return true when Back was handled inside the sheet instead of dismissing it. */
  readonly onBack?: () => boolean;
  readonly onRequestClose?: () => void;
}
