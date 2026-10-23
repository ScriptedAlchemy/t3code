import { describe, expect, it } from "@effect/vitest";
import {
  AuthFilesystemReadScope,
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type AuthSessionState,
  type ProjectCodeQueryInput,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createProjectCodeAtoms, projectCodeIndexBadge } from "./index.ts";

vi.mock("../state/session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("code-environment"),
  label: "Code environment",
  httpBaseUrl: "https://code.example.test",
  wsBaseUrl: "wss://code.example.test",
});
const input: ProjectCodeQueryInput = {
  projectId: ProjectId.make("project"),
  query: { operation: "symbols", filePath: "src/index.ts" },
};
const session = (scopes: ReadonlyArray<typeof AuthFilesystemReadScope>): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [...scopes],
  permissions: [...scopes],
});

const setup = Effect.fn("TestProjectCode.setup")(function* () {
  const requests: ProjectCodeQueryInput[] = [];
  const rpcSession = {
    initialConfig: Effect.succeed({
      environment: { capabilities: { projectCode: true } },
    } as unknown as ServerConfig),
    client: {
      [WS_METHODS.projectCodeQuery]: (request: ProjectCodeQueryInput) =>
        Effect.sync(() => {
          requests.push(request);
          return { operation: "symbols" };
        }),
    },
  } as unknown as RpcSession;
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    }),
    session: yield* SubscriptionRef.make(Option.some(rpcSession)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const runtime = Atom.runtime(
    Layer.succeed(
      EnvironmentRegistry.EnvironmentRegistry,
      EnvironmentRegistry.EnvironmentRegistry.of({
        run,
        followStream,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
    ),
  );
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return { atoms: createProjectCodeAtoms(runtime), registry, requests };
});

describe("project code atoms", () => {
  it.effect("queries with the filesystem read grant and refuses without it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, requests } = yield* setup();
        registry.set(sessions(target.environmentId), AsyncResult.success(session([])));
        expect(registry.get(atoms.query.permissionAtom(target.environmentId))).toBe(false);
        const denied = atoms.query({ environmentId: target.environmentId, input });
        const deniedResult = yield* AtomRegistry.getResult(registry, denied, {
          suspendOnWaiting: true,
        }).pipe(Effect.flip);
        expect(deniedResult).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
        expect(requests).toEqual([]);

        registry.set(
          sessions(target.environmentId),
          AsyncResult.success(session([AuthFilesystemReadScope])),
        );
        expect(registry.get(atoms.query.permissionAtom(target.environmentId))).toBe(true);
        registry.refresh(denied);
        const allowed = yield* AtomRegistry.getResult(registry, denied, {
          suspendOnWaiting: true,
        });
        expect(allowed).toEqual({ operation: "symbols" });
        expect(requests).toEqual([input]);
      }),
    ),
  );

  it("names the indexed commit only when HEAD has moved past a stale index", () => {
    const index = {
      state: "stale" as const,
      indexedCommit: "abcdef0123456789",
      headCommit: "abcdef0123456789",
      generation: 3,
      indexedAt: 0,
      changedFiles: 2,
      changedPaths: ["a.ts", "b.ts"],
    };
    expect(projectCodeIndexBadge(index).label).toBe("Stale");
    expect(projectCodeIndexBadge({ ...index, headCommit: "1234567890abcdef" }).label).toBe(
      "Stale @abcdef0",
    );
    expect(projectCodeIndexBadge({ ...index, state: "unindexed" }).label).toBe("Unavailable");
    expect(projectCodeIndexBadge({ ...index, state: "unindexed", refresh: "building" }).label).toBe(
      "Indexing",
    );
    // A failed refresh leaves the older generation answering, and the badge says so.
    expect(projectCodeIndexBadge({ ...index, refresh: "failed" })).toMatchObject({
      label: "Stale",
      detail: expect.stringContaining("refresh failed"),
    });
    // A server from before index tracking cannot claim the index is ready.
    expect(projectCodeIndexBadge(undefined).label).toBe("Unavailable");
  });
});
