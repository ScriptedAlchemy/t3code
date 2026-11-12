import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderConsumeResetCreditInput,
  type ProviderConsumeResetCreditOutcome,
} from "@t3tools/contracts";
import type { ResetCreditChoice } from "@t3tools/shared/usageLimits";
import { useRef, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

const DEFAULT_CONFIRM_DESCRIPTION =
  "This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.";

const OUTCOME_TEXT: Record<ProviderConsumeResetCreditOutcome, string> = {
  reset: "Reset applied. Your windows have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credit left.",
  alreadyRedeemed: "That credit was already redeemed.",
};

/** Spending a credit asks for confirmation first because it cannot be undone. */
export function useResetCredit(
  environmentId: EnvironmentId,
  input: ProviderConsumeResetCreditInput,
) {
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const consume = useAtomCommand(serverEnvironment.consumeResetCredit, {
    reportFailure: false,
  });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const redeem = async (creditInput: ProviderConsumeResetCreditInput) => {
    if (inFlight.current || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    inFlight.current = true;
    setBusy(true);
    setStatus(null);
    const result = await consume({ environmentId, input: creditInput }).catch(() => null);
    inFlight.current = false;
    setBusy(false);
    if (result?._tag === "Success") {
      setStatus(result.value.warning ?? OUTCOME_TEXT[result.value.outcome]);
      return;
    }
    setStatus(
      result !== null && "error" in result.cause && result.cause.error instanceof Error
        ? result.cause.error.message
        : "Could not use the reset credit.",
    );
  };

  /** Without a choice, redeems the next credit for the hook's `input`. */
  const confirm = (choice?: Pick<ResetCreditChoice, "input" | "confirmDescription">) => {
    if (inFlight.current || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    Dialog.alert("Use a reset credit?", choice?.confirmDescription ?? DEFAULT_CONFIRM_DESCRIPTION, [
      { text: "Cancel", style: "cancel" },
      { text: "Use credit", onPress: () => void redeem(choice?.input ?? input) },
    ]);
  };

  return { canManageProviders, busy, status, confirm };
}
