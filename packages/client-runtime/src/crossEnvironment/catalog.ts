import type { EnvironmentId, OrchestrationProjectShell } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class EnvironmentProjectCatalog extends Context.Service<
  EnvironmentProjectCatalog,
  {
    readonly replace: (
      environmentId: EnvironmentId,
      projects: readonly OrchestrationProjectShell[],
    ) => Effect.Effect<void>;
    readonly projects: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<readonly OrchestrationProjectShell[]>;
  }
>()("@t3tools/client-runtime/crossEnvironment/catalog/EnvironmentProjectCatalog") {}

const make = Effect.gen(function* () {
  const projects = yield* Ref.make(new Map<EnvironmentId, readonly OrchestrationProjectShell[]>());

  // Shell snapshots arrive as a stream, so a span per publish would dominate the trace.
  const replace = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    next: readonly OrchestrationProjectShell[],
  ) {
    yield* Ref.update(projects, (current) => {
      const updated = new Map(current);
      updated.set(environmentId, next);
      return updated;
    });
  });

  const read = Effect.fn("EnvironmentProjectCatalog.projects")(function* (
    environmentId: EnvironmentId,
  ) {
    return (yield* Ref.get(projects)).get(environmentId) ?? [];
  });

  return EnvironmentProjectCatalog.of({ replace, projects: read });
});

export const layer = Layer.effect(EnvironmentProjectCatalog, make);
