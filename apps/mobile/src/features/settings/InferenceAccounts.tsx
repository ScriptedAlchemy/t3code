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
import type { InferenceDriver, InferenceProxyAction } from "@t3tools/contracts";
import { useState } from "react";
import { Linking, TextInput, View } from "react-native";

import { Menu } from "../../components/ui/Menu";
import { ControlPill } from "../../components/ui/ControlPill";
import { AppText } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import type { SettingsTarget } from "./settings-environment-filter";

const drivers = ["codex", "claudeAgent"] as const;
const { inferenceProxy } = serverEnvironment;
const labels = { codex: "Codex", claudeAgent: "Claude" };

function Route({ host, consumer }: { host: EnvironmentPresentation; consumer: SettingsTarget }) {
  const grant = useAtomValue(inferenceProxy.canGrant(host.environmentId));
  const connect = useAtomValue(inferenceProxy.canConnect(consumer.environmentId));
  const status = useEnvironmentQuery(
    inferenceProxy.inferenceStatus({ environmentId: host.environmentId, input: {} }),
  );
  const issue = inferenceRouteIssue(status.data, host.environmentId === consumer.environmentId);
  const route = useAtomCommand(inferenceProxy.routeInference, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function add(driver: InferenceDriver) {
    setBusy(true);
    const result = await route({ host, consumer, driver });
    setBusy(false);
    setNotice(
      result._tag === "Success"
        ? `Select ${labels[driver]} via ${host.label} in the model picker.`
        : String(squashAtomCommandFailure(result)),
    );
  }
  return (
    <View>
      {drivers.map((driver) => (
        <ListActionRow
          key={driver}
          label={`Route ${labels[driver]} through ${host.label}`}
          description={issue ?? undefined}
          disabled={busy || !grant || !connect || !!issue}
          onPress={() => void add(driver)}
        />
      ))}
      {notice ? (
        <AppText accessibilityLiveRegion="polite" className="px-4 text-foreground">
          {notice}
        </AppText>
      ) : null}
    </View>
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
    <View className="gap-2">
      <AppText className="px-4 pt-3 font-semibold text-foreground">Model pools</AppText>
      <SettingsSwitchRow
        label="Round-robin routing"
        subtitle="Distribute requests across eligible credentials. Turn off to use the first available credential."
        value={routing.strategy === "round-robin"}
        disabled={disabled}
        onValueChange={(enabled) =>
          void run({ operation: "setRouting", strategy: enabled ? "round-robin" : "fill-first" })
        }
      />
      <SettingsSwitchRow
        label="Keep sessions on one account"
        subtitle="Reuse the same credential for a conversation while it is available."
        value={routing.sessionAffinity}
        disabled={disabled}
        onValueChange={(sessionAffinity) => void run({ operation: "setRouting", sessionAffinity })}
      />
      {routing.mappings.map((m) => (
        <ListActionRow
          key={m.source + ":" + m.pool}
          label={"Remove " + inferencePoolModel(m)}
          description={inferenceSourceLabels[m.source] + " · " + m.upstream}
          disabled={disabled}
          onPress={() => void run({ operation: "unmapModel", source: m.source, pool: m.pool })}
        />
      ))}
      <View className="flex-row items-center justify-between px-4">
        <AppText className="text-foreground">Model source</AppText>
        <Menu
          accessible
          accessibilityLabel="Model source"
          actions={sources.map((s) => ({
            id: s,
            title: inferenceSourceLabels[s],
            state: s === source ? "on" : "off",
          }))}
          onPressAction={({ nativeEvent }) => {
            const selected = sources.find((s) => s === nativeEvent.event);
            if (selected) setSource(selected);
          }}
        >
          <ControlPill label={inferenceSourceLabels[source]} disabled={disabled} />
        </Menu>
      </View>
      <AppText className="px-4 text-foreground-muted">{hint}</AppText>
      <ListActionRow
        label="Load source models"
        description={
          ids?.length === 0 ? "No models reported. Enter the upstream ID below." : undefined
        }
        disabled={disabled}
        onPress={() => void loadModels()}
      />
      {ids && ids.length > 0 && (
        <View className="self-start px-4">
          <Menu
            accessible
            accessibilityLabel="Choose upstream model"
            actions={ids.map((id) => ({ id, title: id }))}
            onPressAction={({ nativeEvent }) => setUpstream(nativeEvent.event)}
          >
            <ControlPill label="Choose upstream model" />
          </Menu>
        </View>
      )}
      <TextInput
        accessibilityLabel="Upstream model ID"
        placeholder="Upstream model ID"
        value={upstream}
        onChangeText={setUpstream}
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
        className="mx-4 rounded-lg border border-border-subtle px-3 py-2 text-foreground"
      />
      <TextInput
        accessibilityLabel="Pool name"
        placeholder="Pool name, e.g. work"
        value={pool}
        onChangeText={setPool}
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
        className="mx-4 rounded-lg border border-border-subtle px-3 py-2 text-foreground"
      />
      <ListActionRow
        label={
          existing?.upstream === mapping.upstream && source === "traex"
            ? "Refresh bridge key"
            : existing
              ? "Update mapping"
              : "Add mapping"
        }
        description={poolHint}
        disabled={cannotSave}
        onPress={() => void run({ operation: "mapModel", mapping })}
      />
      <AppText className="px-4 text-foreground-muted">
        Apply a route again to refresh its model picker after changing pools.
      </AppText>
    </View>
  );
}

function InferenceControls({ environment }: { environment: SettingsTarget }) {
  const { environmentId } = environment;
  const { environments } = useEnvironments();
  const query = useEnvironmentQuery(inferenceProxy.inferenceStatus({ environmentId, input: {} }));
  const command = useAtomCommand(inferenceProxy.manageInference, { reportFailure: false });
  const permitted = useAtomValue(inferenceProxy.manageInference.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [login, setLogin] = useState<{ url: string; state: string } | null>(null);
  const [callback, setCallback] = useState("");
  const [notice, setNotice] = useState("");
  async function run(input: InferenceProxyAction) {
    setPending(true);
    setNotice("");
    const result = await command({ environmentId, input });
    setPending(false);
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
      result.value.status === "ok" ||
      result.value.status === "error"
    ) {
      setLogin(null);
      setCallback("");
    }
    if (result.value.status === "error")
      setNotice("Sign-in failed or expired. Start a new sign-in.");
    if (result.value.status === "wait")
      setNotice("Waiting for the host to finish sign-in. Check status after a moment.");
    return result.value;
  }
  const host = query.data;
  const updateQuery = useEnvironmentQuery(
    host?.enabled
      ? inferenceProxy.updates({ environmentId, input: { operation: "checkUpdate" } })
      : null,
  );
  const available = updateQuery.data?.update?.available;
  const disabled = pending || !permitted;
  return (
    <View className="gap-1">
      {host ? (
        <>
          <SettingsSwitchRow
            label="Host accounts here"
            subtitle={
              host.problem ??
              (host.running
                ? `CLIProxyAPI ${host.version} is running.`
                : `Enable to install and start CLIProxyAPI ${host.version}.`)
            }
            disabled={disabled}
            value={host.enabled}
            onValueChange={(enabled) =>
              void run({ operation: "configure", enabled, sharing: false })
            }
          />
          {host.enabled && (
            <>
              <ListActionRow
                label={
                  available ? `Update CLIProxyAPI to ${available}` : "Check for CLIProxyAPI updates"
                }
                description={
                  updateQuery.error ??
                  (available
                    ? "Restarts the inference host."
                    : `Installed version: ${host.version}`)
                }
                disabled={disabled || updateQuery.isPending}
                onPress={() =>
                  available ? void run({ operation: "update" }) : updateQuery.refresh()
                }
              />
              <SettingsSwitchRow
                label="Share inference with paired environments"
                subtitle="Use Tailscale HTTPS or a trusted LAN. LAN HTTP sends requests and route keys unencrypted. Turning sharing off revokes remote access."
                disabled={disabled}
                value={host.sharing}
                onValueChange={(sharing) =>
                  void run({ operation: "configure", enabled: true, sharing })
                }
              />
              {host.routing && <ModelPools routing={host.routing} disabled={disabled} run={run} />}
              {host.consumers.map((c) => (
                <ListActionRow
                  key={c.environmentId}
                  label={`Revoke access for ${c.label}`}
                  disabled={disabled}
                  onPress={() => void run({ operation: "revoke", environmentId: c.environmentId })}
                />
              ))}
              {host.accounts.map((account) => (
                <ListActionRow
                  key={account.name}
                  label={`Remove ${account.name}`}
                  description={account.status}
                  disabled={disabled}
                  onPress={() => void run({ operation: "removeAccount", name: account.name })}
                />
              ))}
              {login ? (
                <>
                  <ListActionRow
                    label="Open sign-in page"
                    description="Paste the final localhost URL below, even if your browser cannot load it."
                    onPress={() =>
                      void Linking.openURL(login.url).catch(() =>
                        setNotice("Could not open sign-in page."),
                      )
                    }
                  />
                  <TextInput
                    accessibilityLabel="Sign-in callback URL"
                    placeholder="Paste callback URL"
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!disabled}
                    value={callback}
                    onChangeText={setCallback}
                    className="mx-4 rounded-lg border border-border-subtle px-3 py-2 text-foreground"
                  />
                  <ListActionRow
                    label="Submit callback"
                    disabled={disabled || !callback}
                    onPress={() =>
                      void run({ operation: "callback", state: login.state, callback })
                    }
                  />
                  <ListActionRow
                    label="Check sign-in status"
                    disabled={disabled}
                    onPress={() => void run({ operation: "check", state: login.state })}
                  />
                  <ListActionRow
                    label="Cancel sign-in"
                    disabled={disabled}
                    onPress={() => void run({ operation: "cancel", state: login.state })}
                  />
                </>
              ) : (
                drivers.map((driver) => (
                  <ListActionRow
                    key={driver}
                    label={`Add ${labels[driver]} account`}
                    disabled={disabled}
                    onPress={() => void run({ operation: "signIn", driver })}
                  />
                ))
              )}
            </>
          )}
        </>
      ) : (
        <AppText className="px-4 text-foreground-muted">
          {query.error ?? "Loading host status…"}
        </AppText>
      )}
      {notice ? (
        <AppText accessibilityLiveRegion="polite" className="px-4 text-foreground">
          {notice}
        </AppText>
      ) : null}
      <AppText className="px-4 text-foreground-muted">
        Choose a host for inference. Tools run on {environment.label}. Adding a route retires the
        existing CLI profile pool for that provider.
      </AppText>
      {host?.routes.map((route) => (
        <ListActionRow
          key={route.instanceId}
          label={`Remove ${route.label}`}
          disabled={disabled}
          onPress={() => void run({ operation: "removeRoute", instanceId: route.instanceId })}
        />
      ))}
      {environments
        .filter(
          (e) =>
            e.connection.phase === "connected" &&
            e.serverConfig?.environment.capabilities.inferenceProxy,
        )
        .map((host) => (
          <Route key={host.environmentId} host={host} consumer={environment} />
        ))}
    </View>
  );
}

export function InferenceAccounts({ environment }: { environment: SettingsTarget }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ListActionRow
        label="Inference accounts"
        description={
          open ? "Hide hosts and routes" : "Host accounts or route requests through an environment"
        }
        onPress={() => setOpen((value) => !value)}
      />
      {open && <InferenceControls environment={environment} />}
    </>
  );
}
