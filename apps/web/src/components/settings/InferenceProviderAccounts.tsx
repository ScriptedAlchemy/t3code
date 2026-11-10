import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type InferenceDriver,
  type InferenceProxyAction,
} from "@t3tools/contracts";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

const { inferenceProxy } = serverEnvironment;
const labels = { codex: "Codex", claudeAgent: "Claude" } as const;

export function InferenceProviderAccounts({
  environmentId,
  driver,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver?: InferenceDriver;
  readonly readOnly?: boolean;
}) {
  const canManage =
    useAtomValue(inferenceProxy.manageInference.permissionAtom(environmentId)) && !readOnly;
  const query = useEnvironmentQuery(
    canManage ? inferenceProxy.inferenceStatus({ environmentId, input: {} }) : null,
  );
  const command = useAtomCommand(inferenceProxy.manageInference, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [login, setLogin] = useState<{ url: string; state: string } | null>(null);
  const [callback, setCallback] = useState("");
  const host = query.data;
  async function run(input: InferenceProxyAction) {
    setBusy(true);
    setNotice("");
    const result = await command({ environmentId, input });
    setBusy(false);
    if (result._tag === "Failure") {
      setNotice(String(squashAtomCommandFailure(result)));
      return;
    }
    if (result.value.login) {
      setLogin(result.value.login);
      setCallback("");
    }
    if (input.operation === "cancel" || result.value.status === "ok") {
      setLogin(null);
      setCallback("");
    }
    if (result.value.status === "wait")
      setNotice("Waiting for sign-in to finish. Check status after completing sign-in.");
    if (result.value.status === "error") {
      setLogin(null);
      setCallback("");
      setNotice("Sign-in failed or expired. Start a new sign-in.");
    }
  }
  if (!canManage)
    return <SettingsRow title="Provider management access to the inference host is required." />;
  if (!host) return <SettingsRow title={query.error ?? "Loading accounts…"} />;
  if (!host.enabled)
    return <SettingsRow title="Enable inference hosting on the account host first." />;
  return (
    <>
      {host.accounts
        .filter(
          (account) => !driver || account.provider === (driver === "codex" ? "codex" : "claude"),
        )
        .map((account) => (
          <SettingsRow
            key={account.name}
            title={account.name}
            description={`${account.provider} · ${account.status}`}
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run({ operation: "removeAccount", name: account.name })}
              >
                Remove
              </Button>
            }
          />
        ))}
      {login ? (
        <>
          <SettingsRow
            title="Finish signing in"
            description="Open the provider sign-in page and paste the final localhost URL here, even if the browser cannot load it."
            control={
              <Button
                size="sm"
                variant="outline"
                render={<a href={login.url} target="_blank" rel="noreferrer" />}
              >
                Open sign-in
              </Button>
            }
          />
          <Input
            aria-label="Sign-in callback URL"
            placeholder="Paste callback URL"
            type="password"
            value={callback}
            onChange={(event) => setCallback(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !callback}
              onClick={() => void run({ operation: "callback", state: login.state, callback })}
            >
              Submit
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run({ operation: "check", state: login.state })}
            >
              Check status
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run({ operation: "cancel", state: login.state })}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <SettingsRow
          title="Add an account"
          description="Sign in once for each account this host should use."
          control={
            <div className="flex gap-2">
              {(["codex", "claudeAgent"] as const)
                .filter((candidate) => !driver || driver === candidate)
                .map((driver) => (
                  <Button
                    key={driver}
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run({ operation: "signIn", driver })}
                  >
                    {labels[driver]}
                  </Button>
                ))}
            </div>
          }
        />
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </>
  );
}
