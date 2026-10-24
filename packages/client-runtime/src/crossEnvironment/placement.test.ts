import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectMissingOnTarget,
  ProviderInstanceId,
  RunId,
  SourceIdentityUnresolved,
  TargetModelUnavailable,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentProjectCatalog from "./catalog.ts";
import { parseSourceProject } from "./match.ts";
import * as CrossEnvironmentPlacement from "./placement.ts";
import { hostResources, makePlacementRegistry, projectShell } from "./placementTestSupport.ts";

const isSourceIdentityUnresolved = Schema.is(SourceIdentityUnresolved);

const callerId = EnvironmentId.make("environment:caller");
const destId = EnvironmentId.make("environment:dest");
const sourceProjectId = ProjectId.make("project-source");
const destProjectId = ProjectId.make("project-dest");
const destModel = { instanceId: ProviderInstanceId.make("codex"), model: "dest-model" };

const sourceShell = projectShell({
  id: sourceProjectId,
  canonicalKey: "github.com/org/repo",
  model: "source-model",
});
const destShell = projectShell({
  id: destProjectId,
  canonicalKey: "github.com/org/repo",
  model: "dest-model",
});

const activeSource = () => {
  const source = parseSourceProject({
    id: sourceShell.id,
    repositoryIdentity: sourceShell.repositoryIdentity ?? null,
  });
  if (isSourceIdentityUnresolved(source)) {
    throw new Error("source project has no repository identity");
  }
  return source;
};

const placed = <A, E>(
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  effect: Effect.Effect<
    A,
    E,
    | EnvironmentProjectCatalog.EnvironmentProjectCatalog
    | CrossEnvironmentPlacement.CrossEnvironmentPlacement
  >,
) =>
  effect.pipe(
    Effect.provide(
      CrossEnvironmentPlacement.layer.pipe(
        Layer.provideMerge(EnvironmentProjectCatalog.layer),
        Layer.provideMerge(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
      ),
    ),
  );

describe("CrossEnvironmentPlacement", () => {
  it.effect("lists the host resources sampled from each connected environment", () =>
    Effect.gen(function* () {
      const harness = yield* makePlacementRegistry([
        { id: callerId, label: "Caller" },
        { id: destId, label: "Dest" },
      ]);
      const listed = yield* placed(
        harness.registry,
        Effect.gen(function* () {
          const catalog = yield* EnvironmentProjectCatalog.EnvironmentProjectCatalog;
          yield* catalog.replace(callerId, [sourceShell]);
          yield* catalog.replace(destId, [destShell]);
          const placement = yield* CrossEnvironmentPlacement.CrossEnvironmentPlacement;
          return yield* placement.list({
            callerEnvironmentId: callerId,
            source: activeSource(),
          });
        }),
      );

      expect(listed.environments).toEqual([
        {
          environmentId: callerId,
          label: "Caller",
          isCaller: true,
          resources: hostResources,
          receivedAt: 0,
          repository: { tag: "matched", projectId: sourceProjectId },
        },
        {
          environmentId: destId,
          label: "Dest",
          isCaller: false,
          resources: hostResources,
          receivedAt: 0,
          repository: { tag: "matched", projectId: destProjectId },
        },
      ]);
    }),
  );

  it.effect.each(["run", "thread"] as const)(
    "launches a %s on the destination project root",
    (kind) =>
      Effect.gen(function* () {
        const harness = yield* makePlacementRegistry([
          { id: callerId, label: "Caller" },
          { id: destId, label: "Dest" },
        ]);
        const commandId = CommandId.make(`command-${kind}`);
        const threadId = ThreadId.make(`thread-${kind}`);
        const result = yield* placed(
          harness.registry,
          Effect.gen(function* () {
            const catalog = yield* EnvironmentProjectCatalog.EnvironmentProjectCatalog;
            yield* catalog.replace(callerId, [sourceShell]);
            yield* catalog.replace(destId, [destShell]);
            const placement = yield* CrossEnvironmentPlacement.CrossEnvironmentPlacement;
            return yield* placement.launch({
              callerEnvironmentId: callerId,
              source: activeSource(),
              commandId,
              threadId,
              target: { kind: "environment", environmentId: destId },
              kind,
              title: "Ship it",
              ...(kind === "run" ? { message: "do the thing" } : {}),
              runtimeMode: "full-access",
              interactionMode: "default",
            });
          }),
        );

        expect(result).toMatchObject({
          environmentId: destId,
          projectId: destProjectId,
          threadId,
          runId: RunId.make("run-dest"),
          status: "running",
          kind,
        });
        expect(harness.launches.map((launch) => launch.environmentId)).toEqual([destId]);
        const input = harness.launches[0]?.input;
        expect(input).toMatchObject({
          commandId,
          threadId,
          creationSource: "mcp",
          projectId: destProjectId,
          modelSelection: destModel,
          workspaceStrategy: { type: "root" },
        });
        if (kind === "run") {
          expect(input?.initialMessage).toEqual({ text: "do the thing", attachments: [] });
        } else {
          expect(input?.initialMessage).toBeUndefined();
        }
      }),
  );

  it.effect("does not launch when the destination has no matching project", () =>
    Effect.gen(function* () {
      const harness = yield* makePlacementRegistry([
        { id: callerId, label: "Caller" },
        { id: destId, label: "Dest" },
      ]);
      const error = yield* placed(
        harness.registry,
        Effect.gen(function* () {
          const catalog = yield* EnvironmentProjectCatalog.EnvironmentProjectCatalog;
          yield* catalog.replace(callerId, [sourceShell]);
          yield* catalog.replace(destId, [
            projectShell({
              id: ProjectId.make("project-other"),
              canonicalKey: "github.com/org/other",
              model: "dest-model",
            }),
          ]);
          const placement = yield* CrossEnvironmentPlacement.CrossEnvironmentPlacement;
          return yield* placement
            .launch({
              callerEnvironmentId: callerId,
              source: activeSource(),
              commandId: CommandId.make("command-missing"),
              threadId: ThreadId.make("thread-missing"),
              target: { kind: "environment", environmentId: destId },
              kind: "run",
              title: "Ship it",
              message: "do the thing",
              runtimeMode: "full-access",
              interactionMode: "default",
            })
            .pipe(Effect.flip);
        }),
      );

      expect(error).toBeInstanceOf(ProjectMissingOnTarget);
      expect(error).toMatchObject({ environmentId: destId });
      expect(harness.launches).toEqual([]);
    }),
  );

  it.effect("does not launch when the matched project has no default model", () =>
    Effect.gen(function* () {
      const harness = yield* makePlacementRegistry([
        { id: callerId, label: "Caller" },
        { id: destId, label: "Dest" },
      ]);
      const error = yield* placed(
        harness.registry,
        Effect.gen(function* () {
          const catalog = yield* EnvironmentProjectCatalog.EnvironmentProjectCatalog;
          yield* catalog.replace(callerId, [sourceShell]);
          yield* catalog.replace(destId, [
            projectShell({
              id: destProjectId,
              canonicalKey: "github.com/org/repo",
              model: null,
            }),
          ]);
          const placement = yield* CrossEnvironmentPlacement.CrossEnvironmentPlacement;
          return yield* placement
            .launch({
              callerEnvironmentId: callerId,
              source: activeSource(),
              commandId: CommandId.make("command-model"),
              threadId: ThreadId.make("thread-model"),
              target: { kind: "environment", environmentId: destId },
              kind: "thread",
              title: "Ship it",
              runtimeMode: "full-access",
              interactionMode: "default",
            })
            .pipe(Effect.flip);
        }),
      );

      expect(error).toBeInstanceOf(TargetModelUnavailable);
      expect(harness.launches).toEqual([]);
    }),
  );
});
