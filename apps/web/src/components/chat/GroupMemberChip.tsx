import { UsersIcon } from "lucide-react";

import { ContextChip, ContextChipLabel } from "../ContextChip";

/** `@handle` naming a seated member of the thread's group, in place of a file chip. */
export function GroupMemberChip(props: { label: string; isPrimary: boolean }) {
  return (
    <ContextChip
      kind="model"
      aria-label={`${props.isPrimary ? "Primary" : "Group member"} ${props.label}`}
      contentEditable={false}
    >
      <UsersIcon aria-hidden />
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </ContextChip>
  );
}
