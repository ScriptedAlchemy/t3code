import {
  inferenceRouteIssue,
  inferencePoolModel,
  inferenceSourceLabels,
  isInferenceModelMapping,
  type InferenceModelMapping,
  type InferenceRouting,
  type InferenceProxyActionResult,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type InferenceDriver,
  type InferenceProxyAction,
} from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectTrigger, SelectPopup, SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./settingsLayout";

const { inferenceProxy } = serverEnvironment;
const labels = { codex: "Codex", claudeAgent: "Claude" } as const;

function InferenceRoute({
  host,
  consumer,
}: {
  host: EnvironmentPresentation;
  consumer: EnvironmentPresentation;
}) {
  const canGrant = useAtomValue(inferenceProxy.canGrant(host.environmentId));
  const canConnect = useAtomValue(inferenceProxy.canConnect(consumer.environmentId));
  const status = useEnvironmentQuery(
    inferenceProxy.inferenceStatus({ environmentId: host.environmentId, input: {} }),
  );
  const issue = inferenceRouteIssue(status.data, host.environmentId === consumer.environmentId);
  const route = useAtomCommand(inferenceProxy.routeInference, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function add(driver: InferenceDriver) {
    setBusy(true);
    setNotice("");
    const result = await route({ host, consumer, driver });
    setBusy(false);
    setNotice(
      result._tag === "Failure"
        ? String(squashAtomCommandFailure(result))
        : `Select ${labels[driver]} via ${host.label} in the model picker.`,
    );
  }
  return (
    <SettingsRow
      title={host.label}
      description={
        issue ??
        (host.environmentId === consumer.environmentId
          ? "Use accounts on this environment."
          : "Use this host’s accounts over Tailscale or your trusted LAN.")
      }
      status={notice || undefined}
      control={
        <div className="flex gap-2">
          {(["codex", "claudeAgent"] as const).map((driver) => (
            <Button
              key={driver}
              size="sm"
              variant="outline"
              disabled={!canGrant || !canConnect || busy || !!issue}
              onClick={() => void add(driver)}
            >
              {labels[driver]}
            </Button>
          ))}
        </div>
      }
    />
  );
}

function ModelPools({
  routing,
  disabled,
  run,
}: {
  routing: InferenceRouting;
  disabled: boolean;
  run: (action: InferenceProxyAction) => Promise<InferenceProxyActionResult | undefined>;
}) {
  const [source, setSource] = useState<InferenceModelMapping["source"]>("codex");
  const [pool, setPool] = useState("");
  const [upstream, setUpstream] = useState("");
  const [catalog, setCatalog] = useState<{
    source: InferenceModelMapping["source"];
    ids: readonly string[];
  } | null>(null);
  const ids = catalog?.source === source ? catalog.ids : undefined;
  async function loadModels() {
    const result = await run({ operation: "listModels", source });
    if (result?.models) setCatalog({ source, ids: result.models });
  }
  const mapping = { source, pool: pool.trim(), upstream: upstream.trim() };
  const sources = ["codex", "traex", "claudeAgent"] as const;
  const existing = routing.mappings.find((m) => m.source === source && m.pool === mapping.pool);
  const hint =
    source === "traex"
      ? "Uses the bridge and API key in ~/.traex-bridge on this host."
      : "Use the same pool name for sources that serve equivalent models.";
  const poolHint = mapping.pool
    ? "Model picker ID: " + inferencePoolModel(mapping)
    : "Use lowercase letters, numbers, dots or hyphens.";
  const cannotSave =
    disabled ||
    !isInferenceModelMapping(mapping) ||
    (source !== "traex" && existing?.upstream === mapping.upstream);
  return (
    <SettingsSection title="Model pools">
      <SettingsRow
        title="Round-robin routing"
        description="Distribute requests across eligible credentials. Turn off to use the first available credential."
        control={
          <Switch
            aria-label="Round-robin routing"
            checked={routing.strategy === "round-robin"}
            disabled={disabled}
            onCheckedChange={(enabled) =>
              void run({
                operation: "setRouting",
                strategy: enabled ? "round-robin" : "fill-first",
              })
            }
          />
        }
      />
      <SettingsRow
        title="Keep sessions on one account"
        description="Reuse the same credential for a conversation while it is available."
        control={
          <Switch
            aria-label="Keep sessions on one account"
            checked={routing.sessionAffinity}
            disabled={disabled}
            onCheckedChange={(sessionAffinity) =>
              void run({ operation: "setRouting", sessionAffinity })
            }
          />
        }
      />
      {routing.mappings.map((m) => (
        <SettingsRow
          key={m.source + ":" + m.pool}
          title={inferencePoolModel(m)}
          description={inferenceSourceLabels[m.source] + " · " + m.upstream}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void run({ operation: "unmapModel", source: m.source, pool: m.pool })}
            >
              Remove mapping
            </Button>
          }
        />
      ))}
      <SettingsRow
        title="Model source"
        description={hint}
        control={
          <Select
            value={source}
            disabled={disabled}
            onValueChange={(v) => {
              if (v) setSource(v);
            }}
          >
            <SelectTrigger aria-label="Model source">{inferenceSourceLabels[source]}</SelectTrigger>
            <SelectPopup>
              {sources.map((s) => (
                <SelectItem key={s} value={s}>
                  {inferenceSourceLabels[s]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Available models"
        description={
          ids?.length === 0 ? "No models reported. Enter the upstream ID below." : undefined
        }
        control={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void loadModels()}
            >
              Load source models
            </Button>
            {ids && ids.length > 0 && (
              <Select
                value={upstream}
                disabled={disabled}
                onValueChange={(v) => {
                  if (v) setUpstream(v);
                }}
              >
                <SelectTrigger aria-label="Choose upstream model">Choose model</SelectTrigger>
                <SelectPopup>
                  {ids.map((id) => (
                    <SelectItem key={id} value={id}>
                      {id}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </div>
        }
      />
      <SettingsRow
        title="Upstream model ID"
        control={
          <Input
            aria-label="Upstream model ID"
            value={upstream}
            disabled={disabled}
            onChange={(e) => setUpstream(e.target.value)}
            placeholder="Upstream ID"
          />
        }
      />
      <SettingsRow
        title="Pool name"
        description={poolHint}
        control={
          <Input
            aria-label="Pool name"
            value={pool}
            disabled={disabled}
            onChange={(e) => setPool(e.target.value)}
            placeholder="work"
          />
        }
      />
      <SettingsRow
        title="Publish mapping"
        description="Apply a route again to refresh its model picker after changing pools."
        control={
          <Button
            size="sm"
            disabled={cannotSave}
            onClick={() => void run({ operation: "mapModel", mapping })}
          >
            {existing?.upstream === mapping.upstream && source === "traex"
              ? "Refresh bridge key"
              : existing
                ? "Update mapping"
                : "Add mapping"}
          </Button>
        }
      />
    </SettingsSection>
  );
}

export function InferenceSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const { environments } = useEnvironments();
  const current = environments.find((e) => e.environmentId === environmentId);
  const canManage = useAtomValue(inferenceProxy.manageInference.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    canManage ? inferenceProxy.inferenceStatus({ environmentId, input: {} }) : null,
  );
  const command = useAtomCommand(inferenceProxy.manageInference, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [login, setLogin] = useState<{ url: string; state: string } | null>(null);
  const [callback, setCallback] = useState("");
  const host = query.data;
  const updateQuery = useEnvironmentQuery(
    host?.enabled
      ? inferenceProxy.updates({ environmentId, input: { operation: "checkUpdate" } })
      : null,
  );
  const available = updateQuery.data?.update?.available;
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
    if (
      input.operation === "cancel" ||
      (input.operation === "configure" && !input.enabled) ||
      result.value.status === "ok"
    ) {
      setLogin(null);
      setCallback("");
    }
    if (result.value.status === "wait")
      setNotice("Waiting for the host to finish sign-in. Check status after a moment.");
    if (result.value.status === "error") {
      setLogin(null);
      setCallback("");
      setNotice("Sign-in failed or expired. Start a new sign-in.");
    }
    return result.value;
  }
  return (
    <SettingsPageContainer className="gap-8">
      <SettingsSection id="account-pools" title="Inference hosting">
        {!canManage ? (
          <SettingsRow title="Provider management access is required." />
        ) : host ? (
          <>
            <SettingsRow
              title="Host accounts on this environment"
              description={`T3 Code installs CLIProxyAPI ${host.version} and keeps account logins here.`}
              status={busy ? "Working…" : (host.problem ?? (host.running ? "Running" : "Stopped"))}
              control={
                <Switch
                  aria-label="Host inference accounts"
                  checked={host.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) =>
                    void run({ operation: "configure", enabled, sharing: false })
                  }
                />
              }
            />
            {host.enabled && (
              <>
                <SettingsRow
                  title="CLIProxyAPI updates"
                  description={
                    updateQuery.error ??
                    (available
                      ? `Version ${available} is available. Updating restarts the inference host.`
                      : `Installed version: ${host.version}`)
                  }
                  control={
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || updateQuery.isPending}
                      onClick={() =>
                        available ? void run({ operation: "update" }) : updateQuery.refresh()
                      }
                    >
                      {available ? "Update" : "Check for updates"}
                    </Button>
                  }
                />
                <SettingsRow
                  title="Share inference with paired environments"
                  description="Use Tailscale HTTPS or enable LAN access on a trusted network. LAN HTTP sends requests and route keys unencrypted. Turning sharing off revokes remote access."
                  control={
                    <Switch
                      aria-label="Share inference with paired environments"
                      checked={host.sharing}
                      disabled={busy}
                      onCheckedChange={(sharing) =>
                        void run({ operation: "configure", enabled: true, sharing })
                      }
                    />
                  }
                />
                {host.consumers.map((c) => (
                  <SettingsRow
                    key={c.environmentId}
                    title={c.label}
                    description="Authorized for inference"
                    control={
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run({ operation: "revoke", environmentId: c.environmentId })
                        }
                      >
                        Revoke
                      </Button>
                    }
                  />
                ))}
              </>
            )}
          </>
        ) : (
          <SettingsRow title={query.error ?? "Loading host status…"} />
        )}
      </SettingsSection>
      {host?.enabled && (
        <SettingsSection title="Hosted accounts">
          {host.accounts.map((account) => (
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
                  {(["codex", "claudeAgent"] as const).map((driver) => (
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
        </SettingsSection>
      )}
      {host?.enabled && host.routing && (
        <ModelPools routing={host.routing} disabled={busy || !canManage} run={run} />
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {current && canManage && (
        <SettingsSection title="Route requests through an environment">
          <SettingsRow
            title={`Run agents on ${current.label}`}
            description="Choose a host and provider below. Tools and files stay on this environment. Adding a route retires its existing CLI profile pool."
          />
          {host?.routes.map((route) => (
            <SettingsRow
              key={route.instanceId}
              title={route.label}
              description="Configured on this environment"
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run({ operation: "removeRoute", instanceId: route.instanceId })
                  }
                >
                  Remove route
                </Button>
              }
            />
          ))}
          {environments
            .filter(
              (e) =>
                e.connection.phase === "connected" &&
                e.serverConfig?.environment.capabilities.inferenceProxy,
            )
            .map((e) => (
              <InferenceRoute key={e.environmentId} host={e} consumer={current} />
            ))}
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
