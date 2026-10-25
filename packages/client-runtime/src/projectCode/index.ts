import {
  WS_METHODS,
  type ProjectCodeIndexInfo,
  type ProjectCodeQueryInput,
  type ProjectFileHistoryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  EnvironmentRpcUnavailableError,
  getInitialServerConfig,
  requestGuarded,
} from "../rpc/client.ts";
import { createEnvironmentGuardedRpcQueryAtomFamily } from "../state/runtime.ts";

const requireProjectCode = Effect.fn("ProjectCode.requireCapability")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const config = yield* getInitialServerConfig();
  if (config.environment.capabilities.projectCode !== true) {
    return yield* new EnvironmentRpcUnavailableError({
      environmentId: supervisor.target.environmentId,
      message: "This server does not support project code queries.",
    });
  }
});

export function createProjectCodeAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    query: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "project-code:query",
      tag: WS_METHODS.projectCodeQuery,
      staleTimeMs: 0,
      execute: Effect.fn("ProjectCode.query")(function* (input: ProjectCodeQueryInput) {
        yield* requireProjectCode();
        return yield* requestGuarded(WS_METHODS.projectCodeQuery, input);
      }),
    }),
    // Badges read freshness without indexing; a short stale window keeps remounts from
    // starting a worker each time a panel reopens.
    freshness: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "project-code:freshness",
      tag: WS_METHODS.projectCodeQuery,
      staleTimeMs: 30_000,
      execute: Effect.fn("ProjectCode.freshness")(function* (input: ProjectCodeQueryInput) {
        yield* requireProjectCode();
        return yield* requestGuarded(WS_METHODS.projectCodeQuery, input);
      }),
    }),
    fileHistory: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "project-code:file-history",
      tag: WS_METHODS.projectCodeFileHistory,
      staleTimeMs: 0,
      execute: Effect.fn("ProjectCode.fileHistory")(function* (input: ProjectFileHistoryInput) {
        yield* requireProjectCode();
        return yield* requestGuarded(WS_METHODS.projectCodeFileHistory, input);
      }),
    }),
  };
}

export type ProjectCodeIndexBadge = {
  readonly label: string;
  readonly tone: "ok" | "warn" | "muted";
  readonly detail: string;
};

/**
 * The plain-text badge every client shows for an index. Stale names the commit the index was
 * built at when HEAD has moved since, otherwise how many files changed under it.
 */
export function projectCodeIndexBadge(
  index: ProjectCodeIndexInfo | undefined,
): ProjectCodeIndexBadge {
  if (index === undefined) {
    return {
      label: "Unavailable",
      tone: "muted",
      detail: "This server does not report index freshness.",
    };
  }
  const indexedAt = index.indexedCommit === null ? null : index.indexedCommit.slice(0, 7);
  switch (index.state) {
    case "ready":
      return {
        label: "Ready",
        tone: "ok",
        detail:
          indexedAt === null
            ? `Index generation ${index.generation} matches the checkout.`
            : `Index generation ${index.generation} matches the checkout at ${indexedAt}.`,
      };
    case "partial":
      return {
        label: "Partial",
        tone: "warn",
        detail: "Some files are not indexed or references are unresolved. Results may be missing.",
      };
    case "stale": {
      const files = `${index.changedFiles} ${index.changedFiles === 1 ? "file has" : "files have"} changed since indexing.`;
      const moved =
        indexedAt !== null && index.headCommit !== null && index.headCommit !== index.indexedCommit;
      return {
        label: moved ? `Stale @${indexedAt}` : "Stale",
        tone: "warn",
        detail: `${files} The next code query re-indexes them.`,
      };
    }
    case "indexing":
      return {
        label: "Indexing",
        tone: "muted",
        detail: "Another code query is indexing this checkout.",
      };
    case "unindexed":
      return {
        label: "Unavailable",
        tone: "muted",
        detail: "This checkout has not been indexed yet. The first code query indexes it.",
      };
  }
}
