import {
  EnvironmentId,
  managedCapabilityDenial,
  managedUpdatesDenial,
  ProviderDriverKind,
  InferenceConsumer,
  InferenceProxyError,
  ProviderInstanceId,
  isManagedDriverAllowed,
  isInferenceConfig,
  type InferenceProxyAction,
  type InferenceProxyActionResult,
  type InferenceProxyStatus,
  type InferenceRouteGrant,
  type InferenceRouteInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { NetService } from "@t3tools/shared/Net";
import { readTailscaleServeRoutesTo } from "@t3tools/tailscale";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schedule from "effect/Schedule";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { DirectEndpoints } from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { install, proxyVersion, resolveRelease, Release } from "./install.ts";
import { routeProvider, validateRouteUrl } from "./routes.ts";

const Saved = Schema.Struct({
  enabled: Schema.Boolean,
  sharing: Schema.Boolean,
  port: Schema.Int,
  release: Schema.optionalKey(Release),
  grants: Schema.Array(Schema.Struct({ ...InferenceConsumer.fields, key: Schema.String })),
});
type Saved = typeof Saved.Type;
const empty: Saved = { enabled: false, sharing: false, port: 0, grants: [] };
const Files = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      provider: Schema.String,
      status: Schema.String,
    }),
  ),
});
const Peer = Schema.Struct({ environmentId: EnvironmentId });
const Models = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.String, owned_by: Schema.optional(Schema.String) }),
  ),
});
const Login = Schema.Struct({ state: Schema.String, url: Schema.String });
const AuthStatus = Schema.Struct({ status: Schema.Literals(["ok", "error", "wait"]) });
const failure = (message: string) => new InferenceProxyError({ message });
const isInferenceFailure = Schema.is(InferenceProxyError);
const decodeSaved = Schema.decodeEffect(Schema.fromJsonString(Saved));
const encodeSaved = Schema.encodeEffect(Schema.fromJsonString(Saved));
const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const safeFailure = (message: string) => (cause: unknown) =>
  isInferenceFailure(cause) ? cause : failure(message);

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;
  const newKey = random
    .randomBytes(32)
    .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("base64url")));
  const jsonRequest = Effect.fn("InferenceProxy.request")(
    function* <A>(
      url: string,
      key: string | undefined,
      schema: Schema.Decoder<A>,
      method: HttpMethod.HttpMethod = "GET",
      body?: object,
    ) {
      let request = HttpClientRequest.make(method)(url);
      if (key !== undefined)
        request = HttpClientRequest.setHeader(request, "authorization", "Bearer " + key);
      if (body) request = yield* HttpClientRequest.bodyJson(request, body);
      const response = yield* client.execute(request);
      if (response.status < 200 || response.status >= 300)
        return yield* failure(`CLIProxyAPI returned HTTP ${response.status}.`);
      return yield* Schema.decodeEffect(schema)(yield* response.json);
    },
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.timeout("10 seconds"),
    Effect.mapError(safeFailure("Could not reach CLIProxyAPI or decode its response.")),
  );
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const net = yield* NetService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const direct = yield* DirectEndpoints;
  const env = yield* HostProcess.Environment;
  const sharingDenial = managedCapabilityDenial(settings.managedPolicy, "remoteClients");
  const installContext = yield* Effect.context<Effect.Services<ReturnType<typeof install>>>();
  const latest = yield* Effect.cachedWithTTL(
    resolveRelease(undefined).pipe(Effect.provide(installContext)),
    (exit) => (Exit.isSuccess(exit) ? "15 minutes" : 0),
  );
  const mutex = yield* Semaphore.make(1);
  const updateMutex = yield* Semaphore.make(1);
  const children = yield* Queue.sliding<ChildProcessSpawner.ChildProcessHandle>(1);
  const directory = path.join(config.stateDir, "inference-proxy");
  let cached: Saved | undefined;
  let running:
    | {
        child: ChildProcessSpawner.ChildProcessHandle;
        scope: Scope.Closeable;
        baseUrl: string;
        key: string;
        management: string;
      }
    | undefined;
  const read = Effect.gen(function* () {
    if (cached) return cached;
    const raw = yield* store.get("inference-proxy-state");
    cached = Option.isSome(raw) ? yield* decodeSaved(new TextDecoder().decode(raw.value)) : empty;
    return cached;
  });
  const save = Effect.fn("InferenceProxy.save")(function* (next: Saved) {
    yield* store.set("inference-proxy-state", new TextEncoder().encode(yield* encodeSaved(next)));
    cached = next;
  }, Effect.uninterruptible);
  const stop = Effect.gen(function* () {
    if (running) yield* Scope.close(running.scope, Exit.void);
    running = undefined;
  });
  yield* Effect.addFinalizer(() => stop);
  const ensure = Effect.fn("InferenceProxy.start")(function* (state: Saved) {
    if (!state.enabled)
      return yield* failure("Enable inference hosting on this environment first.");
    if (running && (yield* running.child.isRunning)) return running;
    yield* stop;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const executable = yield* install(directory, state.release).pipe(
      Effect.provide(installContext),
      Effect.mapError(
        safeFailure(
          "Could not install the pinned CLIProxyAPI release. Check network access and retry.",
        ),
      ),
    );
    const key = Buffer.from(yield* store.getOrCreateRandom("inference-proxy-local", 32)).toString(
      "base64url",
    );
    const management = yield* newKey;
    const authDir = path.join(directory, "accounts");
    yield* fs.makeDirectory(authDir, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "config.yaml");
    yield* fs.writeFileString(
      file,
      yield* encodeConfig({
        "config-version": 8,
        server: { host: "127.0.0.1", port: state.port, "max-request-body-bytes": 64 * 1024 * 1024 },
        oauth: { "auth-dir": authDir },
        access: { "api-keys": [key] },
        requests: { "passthrough-headers": true },
        management: {
          "allow-remote": false,
          "secret-key": management,
          "disable-control-panel": true,
        },
        routing: { strategy: "round-robin", "session-affinity": true },
      }),
      { mode: 0o600 },
    );
    const scope = yield* Scope.make();
    const baseUrl = `http://127.0.0.1:${state.port}`;
    return yield* Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(executable, ["-config", file, "-local-model"], {
            cwd: directory,
            env: {
              HOME: directory,
              USERPROFILE: directory,
              PATH: env.PATH,
              SystemRoot: env.SystemRoot,
              TEMP: env.TEMP,
              TMP: env.TMP,
              SSL_CERT_FILE: env.SSL_CERT_FILE,
            },
            extendEnv: false,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            forceKillAfter: "2 seconds",
          }),
        )
        .pipe(Scope.provide(scope));
      // A fresh management secret proves that this listener belongs to the process we just started.
      yield* jsonRequest(baseUrl + "/v0/management/auth-files", management, Files).pipe(
        Effect.retry({ times: 40, schedule: Schedule.spaced("100 millis") }),
        Effect.timeout("8 seconds"),
      );
      running = { child, scope, key, management, baseUrl };
      yield* Queue.offer(children, child);
      return running;
    }).pipe(
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void)),
    );
  });

  const watchChild = Effect.fn("InferenceProxy.watchChild")(function* () {
    const child = yield* Queue.take(children);
    yield* child.exitCode;
    if (running?.child !== child) return;
    // Local providers call the sidecar directly, so their next turn cannot wake a stopped host.
    yield* Effect.sleep("1 second");
    yield* mutex
      .withPermit(
        Effect.gen(function* () {
          const state = yield* read;
          if (state.enabled && (!running || running.child === child)) yield* ensure(state);
        }),
      )
      .pipe(Effect.retry({ times: 2, schedule: Schedule.exponential("1 second") }));
  });
  yield* watchChild().pipe(Effect.ignore, Effect.forever, Effect.forkScoped);

  const status = mutex
    .withPermit(
      Effect.gen(function* () {
        const state = yield* read;
        const { providerInstances } = yield* settings.getSettings;
        const summary = {
          routes: Object.entries(providerInstances).flatMap(([id, instance]) =>
            isInferenceConfig(instance.config)
              ? [{ instanceId: ProviderInstanceId.make(id), label: instance.displayName ?? id }]
              : [],
          ),
          version: state.release?.version ?? proxyVersion,
          enabled: state.enabled,
          sharing: state.sharing,
          consumers: state.grants.map(({ environmentId, label }) => ({ environmentId, label })),
        };
        if (!state.enabled) return { ...summary, running: false, accounts: [], problem: null };
        return yield* Effect.gen(function* () {
          const runtime = yield* ensure(state);
          const { files } = yield* jsonRequest(
            runtime.baseUrl + "/v0/management/auth-files",
            runtime.management,
            Files,
          );
          return { ...summary, running: true, accounts: files, problem: null };
        }).pipe(
          Effect.orElseSucceed((e) => ({
            ...summary,
            running: false,
            accounts: [],
            problem: safeFailure("CLIProxyAPI failed to start. Check its port or retry hosting.")(e)
              .message,
          })),
        );
      }),
    )
    .pipe(Effect.mapError(safeFailure("Could not read inference host settings.")));

  const sharingUrls = Effect.gen(function* () {
    const active = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    const port = Option.isSome(active) ? active.value.port : config.port;
    const targets = [
      ...new Set([port, ...(config.devUrl?.port ? [Number(config.devUrl.port)] : [])]),
    ];
    const routes = yield* Effect.forEach(targets, (target) =>
      readTailscaleServeRoutesTo({ host: "127.0.0.1", port: target }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.orElseSucceed(() => []),
      ),
    );
    const route = routes
      .flat()
      .find((r) => r.mount === "/" && r.host?.endsWith(".ts.net") && !r.ambiguous);
    const lans = (yield* direct.resolveAvailable())
      .filter((ep) => ep.kind === "lan")
      .map((ep) => new URL("/api/inference", ep.httpBaseUrl).href)
      .filter((url) => validateRouteUrl(url, false));
    const urls = [
      ...(route ? [new URL(`https://${route.host}:${route.servePort}/api/inference`).href] : []),
      ...lans,
    ];
    if (!urls.length)
      return yield* failure(
        "Enable LAN access or Tailscale HTTPS on the hosting environment, then retry.",
      );
    return urls;
  });

  const updateRuntime = Effect.fn("InferenceProxy.updateRuntime")(function* (
    operation: "checkUpdate" | "update",
  ) {
    const state = yield* mutex.withPermit(read);
    const denial = managedUpdatesDenial(settings.managedPolicy);
    if (!state.enabled || denial) {
      if (operation === "update")
        return yield* failure(denial ?? "Enable inference hosting first.");
      return {};
    }
    const current = state.release?.version ?? proxyVersion;
    const release = yield* latest.pipe(
      Effect.mapError(safeFailure("Could not check upstream CLIProxyAPI releases.")),
    );
    const available =
      release.version.localeCompare(current, "en", { numeric: true }) > 0 ? release.version : null;
    if (operation === "checkUpdate" || !available) return { update: { current, available } };
    yield* install(directory, release).pipe(
      Effect.provide(installContext),
      Effect.mapError(safeFailure("Could not install the verified CLIProxyAPI update.")),
    );
    yield* mutex.withPermit(
      Effect.gen(function* () {
        const before = yield* read;
        if (!before.enabled) return yield* failure("Hosting was disabled during the update.");
        const next = { ...before, release: { version: release.version } };
        yield* Effect.uninterruptibleMask((restore) =>
          stop.pipe(
            Effect.andThen(restore(ensure(next))),
            Effect.andThen(save(next)),
            Effect.onError(() => stop.pipe(Effect.andThen(ensure(before)), Effect.ignore)),
          ),
        );
      }),
    );
    const runtimeDir = path.join(directory, "runtime");
    yield* fs.readDirectory(runtimeDir).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          entries,
          (entry) => {
            const match = /^(\d+\.\d+\.\d+)-(.+)$/.exec(entry);
            if (
              !match ||
              match[2] !== release.target ||
              match[1] === current ||
              match[1]!.localeCompare(release.version, "en", { numeric: true }) >= 0
            )
              return Effect.void;
            return fs.remove(path.join(runtimeDir, entry), { recursive: true });
          },
          { discard: true },
        ),
      ),
      Effect.catch(() => Effect.logWarning("Could not remove obsolete CLIProxyAPI releases.")),
    );
    return { update: { current: release.version, available: null } };
  });
  type HostAction = Exclude<InferenceProxyAction, { operation: "checkUpdate" | "update" }>;
  const manageHost = Effect.fn("InferenceProxy.manageHost")(function* (input: HostAction) {
    const state = yield* read;
    if (input.operation === "configure") {
      if (input.enabled && input.sharing && sharingDenial) return yield* failure(sharingDenial);
      if (!input.enabled) {
        yield* save({ ...state, enabled: false, sharing: false, grants: [] }).pipe(
          Effect.andThen(stop),
          Effect.uninterruptible,
        );
      } else {
        if (input.sharing) yield* sharingUrls;
        const next = {
          ...state,
          enabled: true,
          sharing: input.sharing,
          port: state.port || (yield* net.reserveLoopbackPort("127.0.0.1")),
          grants: input.sharing ? state.grants : [],
        };
        yield* Effect.uninterruptibleMask((restore) =>
          restore(ensure(next)).pipe(
            Effect.andThen(save(next)),
            Effect.onError(() => (state.enabled ? Effect.void : stop)),
          ),
        );
      }
      return {};
    }
    if (input.operation === "removeRoute") {
      const { providerInstances } = yield* settings.getSettings;
      if (!isInferenceConfig(providerInstances[input.instanceId]?.config))
        return yield* failure("This provider is not an inference route.");
      yield* settings.updateProviderInstance({
        operation: "remove",
        instanceId: input.instanceId,
      });
      return {};
    }
    if (input.operation === "revoke") {
      yield* save({
        ...state,
        grants: state.grants.filter((g) => g.environmentId !== input.environmentId),
      });
      return {};
    }
    const runtime = yield* ensure(state);
    const base = runtime.baseUrl + "/v0/management/";
    const admin = runtime.management;
    switch (input.operation) {
      case "signIn": {
        if (!isManagedDriverAllowed(settings.managedPolicy, ProviderDriverKind.make(input.driver)))
          return yield* failure("This driver is disabled by environment policy.");
        const login = yield* jsonRequest(
          base + (input.driver === "codex" ? "codex" : "anthropic") + "-auth-url",
          admin,
          Login,
        );
        if (URL.parse(login.url)?.protocol !== "https:")
          return yield* failure("Invalid sign-in URL.");
        return { login };
      }
      case "check":
        return yield* jsonRequest(
          base + "get-auth-status?state=" + encodeURIComponent(input.state),
          admin,
          AuthStatus,
        );
      case "cancel":
        yield* jsonRequest(
          base + "oauth-session?state=" + encodeURIComponent(input.state),
          admin,
          Schema.Unknown,
          "DELETE",
        );
        return {};
      case "callback": {
        const url = URL.parse(input.callback);
        if (!url || url.searchParams.get("state") !== input.state)
          return yield* failure("Paste the complete callback URL from this sign-in.");
        yield* jsonRequest(base + "oauth-callback", admin, Schema.Unknown, "POST", {
          redirect_url: input.callback,
        });
        return { status: "wait" as const };
      }
      case "removeAccount": {
        if (input.name !== path.basename(input.name) || !input.name.endsWith(".json"))
          return yield* failure("Invalid account file name.");
        yield* jsonRequest(
          base + "auth-files?name=" + encodeURIComponent(input.name),
          admin,
          Schema.Unknown,
          "DELETE",
        );
        return {};
      }
    }
  }, mutex.withPermit);
  const manage = Effect.fn("InferenceProxy.manage")(
    function* (input: InferenceProxyAction) {
      switch (input.operation) {
        case "checkUpdate":
          return yield* updateRuntime("checkUpdate");
        case "update":
          return yield* updateMutex.withPermit(updateRuntime("update"));
        default:
          return yield* manageHost(input);
      }
    },
    Effect.mapError(safeFailure("Could not update the inference host.")),
  );

  const grant = Effect.fn("InferenceProxy.grant")(
    function* (consumer: InferenceConsumer) {
      const state = yield* read;
      const runtime = yield* ensure(state);
      const hostId = yield* environment.getEnvironmentId;
      const identity = { hostId, consumerId: consumer.environmentId };
      if (hostId === consumer.environmentId)
        return { ...identity, baseUrl: runtime.baseUrl, key: runtime.key };
      if (sharingDenial) return yield* failure(sharingDenial);
      if (!state.sharing) return yield* failure("Enable sharing on the inference host first.");
      const [baseUrl, ...alternates] = (yield* sharingUrls).slice(0, 33);
      const existing = state.grants.find((g) => g.environmentId === consumer.environmentId);
      const key = existing?.key ?? (yield* newKey);
      if (!existing || existing.label !== consumer.label)
        yield* save({
          ...state,
          grants: [
            ...state.grants.filter((g) => g.environmentId !== consumer.environmentId),
            { ...consumer, key },
          ],
        });
      return { ...identity, baseUrl: baseUrl!, alternates, key };
    },
    mutex.withPermit,
    Effect.mapError(safeFailure("Could not resolve the host's inference addresses.")),
  );

  const authorize = Effect.fn("InferenceProxy.authorize")(
    function* (key: string) {
      const state = yield* read;
      if (
        sharingDenial ||
        !state.enabled ||
        !state.sharing ||
        !state.grants.some((g) => g.key === key)
      )
        return null;
      const runtime = yield* ensure(state);
      return { baseUrl: runtime.baseUrl, key: runtime.key };
    },
    mutex.withPermit,
    Effect.mapError(safeFailure("Inference host unavailable.")),
  );

  const connect = Effect.fn("InferenceProxy.connect")(
    function* ({ grant, driver, hostLabel }: InferenceRouteInput) {
      const id = yield* environment.getEnvironmentId;
      if (id !== grant.consumerId)
        return yield* failure("Invalid inference route for this environment.");
      if (!isManagedDriverAllowed(settings.managedPolicy, ProviderDriverKind.make(driver)))
        return yield* failure("This driver is disabled by environment policy.");
      const local = id === grant.hostId;
      const candidates = local ? [grant.baseUrl] : [grant.baseUrl, ...(grant.alternates ?? [])];
      if (candidates.some((url) => !validateRouteUrl(url, local)))
        return yield* failure("Invalid inference route for this environment.");
      if (local) {
        const runtime = yield* mutex.withPermit(read.pipe(Effect.flatMap(ensure)));
        if (runtime.baseUrl !== grant.baseUrl || runtime.key !== grant.key)
          return yield* failure("The local inference grant has changed. Request a new route.");
      }
      const { baseUrl, data } = yield* Effect.firstSuccessOf(
        candidates.map((url) =>
          Effect.gen(function* () {
            if (!local) {
              const peer = yield* jsonRequest(
                new URL("/.well-known/t3/environment", url).href,
                undefined,
                Peer,
              );
              if (peer.environmentId !== grant.hostId)
                return yield* failure("The address belongs to another T3 environment.");
            }
            const { data } = yield* jsonRequest(url + "/v1/models", grant.key, Models);
            return { baseUrl: url, data };
          }),
        ),
      );
      const models = data
        .filter((model) => {
          const owner = model.owned_by?.toLowerCase();
          if (owner === "openai") return driver === "codex";
          if (owner === "anthropic") return driver === "claudeAgent";
          return driver === "codex"
            ? /^(codex-|gpt-|o\d)/i.test(model.id)
            : /^claude-/i.test(model.id);
        })
        .map((m) => m.id);
      if (!models.length)
        return yield* failure("Sign in to an account for this provider on the host, then retry.");
      const hash = yield* Effect.promise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(grant.hostId)),
      );
      const instanceId = ProviderInstanceId.make(
        `inference_${driver}_${Buffer.from(hash).toString("hex").slice(0, 16)}`,
      );
      const home = path.join(config.stateDir, "providers", "inference", instanceId);
      yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 });
      const instance = routeProvider(driver, baseUrl, grant.key, hostLabel, models, home);
      yield* settings.updateProviderInstance(
        { operation: "upsert", instanceId, instance },
        { providerPools: { [driver]: null } },
      );
    },
    Effect.mapError(safeFailure("Could not configure the routed provider.")),
  );
  yield* read.pipe(
    Effect.flatMap((state) => (state.enabled ? Effect.asVoid(ensure(state)) : Effect.void)),
    mutex.withPermit,
    Effect.ignore,
    Effect.forkScoped,
  );
  return { status, manage, authorize, grant, connect };
});

export class InferenceProxy extends Context.Service<
  InferenceProxy,
  {
    readonly status: Effect.Effect<InferenceProxyStatus, InferenceProxyError>;
    readonly manage: (
      input: InferenceProxyAction,
    ) => Effect.Effect<InferenceProxyActionResult, InferenceProxyError>;
    readonly grant: (
      input: InferenceConsumer,
    ) => Effect.Effect<InferenceRouteGrant, InferenceProxyError>;
    readonly connect: (input: InferenceRouteInput) => Effect.Effect<void, InferenceProxyError>;
    readonly authorize: (
      key: string,
    ) => Effect.Effect<{ baseUrl: string; key: string } | null, InferenceProxyError>;
  }
>()("t3/inference/InferenceProxy") {}
export const layer = Layer.effect(InferenceProxy, make);
