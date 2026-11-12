import {
  TextGenerationError,
  type ModelSelection,
  type TextGenerationOperation,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const Config = Schema.Record(Schema.String, Schema.Unknown);
type Config = typeof Config.Type;
const decodeConfig = Schema.decodeUnknownOption(fromLenientJson(Config));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(Config));
const isConfig = Schema.is(Config);
const isTextGenerationError = Schema.is(TextGenerationError);
const ROUTING_KEYS = ["provider", "providers", "enabled_providers", "disabled_providers"] as const;

function readRoutingConfig(content: string): Config | undefined {
  const decoded = decodeConfig(content);
  if (Option.isNone(decoded)) return undefined;
  return Object.fromEntries(
    ROUTING_KEYS.flatMap((key) => {
      const value = decoded.value[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function mergeConfig(target: Config, source: Config): Config {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const previous = result[key];
    result[key] = isConfig(previous) && isConfig(value) ? mergeConfig(previous, value) : value;
  }
  return result;
}

export const makeBlindEvaluationEnvironment = Effect.fn("OpenCode.makeBlindEvaluationEnvironment")(
  function* (input: {
    readonly operation: TextGenerationOperation;
    readonly directory: string;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const invalid = () =>
      new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode configuration could not be isolated for blind evaluation.",
      });
    const readConfig = (filePath: string) =>
      fs.readFileString(filePath).pipe(
        Effect.catchIf(
          (cause) => cause.reason._tag === "NotFound",
          () => Effect.succeed("{}"),
        ),
        Effect.flatMap((content) => {
          const config = readRoutingConfig(content);
          return config === undefined ? Effect.fail(invalid()) : Effect.succeed(config);
        }),
        Effect.mapError((cause) => (isTextGenerationError(cause) ? cause : invalid())),
      );

    let routing: Config = {};
    const home = input.environment.HOME ?? input.environment.USERPROFILE;
    const configHome = input.environment.XDG_CONFIG_HOME;
    const globalDirectory =
      configHome !== undefined && configHome.trim().length > 0
        ? path.join(configHome, "opencode")
        : home === undefined
          ? undefined
          : path.join(home, ".config", "opencode");
    const directories = [
      ...(globalDirectory === undefined ? [] : [globalDirectory]),
      ...(input.environment.OPENCODE_CONFIG_DIR === undefined
        ? []
        : [
            path.resolve(
              input.directory,
              expandHomePath(input.environment.OPENCODE_CONFIG_DIR, home ?? ""),
            ),
          ]),
    ];
    for (const directory of directories) {
      for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
        routing = mergeConfig(routing, yield* readConfig(path.join(directory, name)));
      }
    }
    if (input.environment.OPENCODE_CONFIG !== undefined) {
      const configuredPath = path.resolve(
        input.directory,
        expandHomePath(input.environment.OPENCODE_CONFIG, home ?? ""),
      );
      routing = mergeConfig(routing, yield* readConfig(configuredPath));
    }
    if (input.environment.OPENCODE_CONFIG_CONTENT !== undefined) {
      const content = readRoutingConfig(input.environment.OPENCODE_CONFIG_CONTENT);
      if (content === undefined) return yield* invalid();
      routing = mergeConfig(routing, content);
    }

    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-evaluation-" });
    const xdgConfigHome = path.join(temporary, "xdg-config");
    const configDirectory = path.join(temporary, "config");
    yield* fs.makeDirectory(xdgConfigHome, { recursive: true });
    yield* fs.makeDirectory(configDirectory, { recursive: true });
    const {
      OPENCODE_CONFIG: _config,
      OPENCODE_CONFIG_DIR: _configDirectory,
      OPENCODE_PERMISSION: _permission,
      XDG_CONFIG_HOME: _xdgConfigHome,
      ...preserved
    } = input.environment;
    return {
      ...preserved,
      XDG_CONFIG_HOME: xdgConfigHome,
      OPENCODE_CONFIG_DIR: configDirectory,
      OPENCODE_CONFIG_CONTENT: encodeConfig(routing),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    } satisfies NodeJS.ProcessEnv;
  },
  (effect) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: "generateModelEvaluation",
              detail: "OpenCode configuration could not be isolated for blind evaluation.",
              cause,
            }),
      ),
    ),
);

export const validateBlindEvaluationSelection = (
  modelSelection: ModelSelection,
  operation: TextGenerationOperation,
) => {
  const unsupported = modelSelection.options?.find(
    (option, index) => option.id !== "variant" || typeof option.value !== "string" || index > 0,
  );
  return unsupported === undefined
    ? Effect.void
    : Effect.fail(
        new TextGenerationError({
          operation,
          detail: `OpenCode blind evaluation does not support the '${unsupported.id}' model option.`,
        }),
      );
};

export const hasBlindEvaluationPartActivity = (parts: ReadonlyArray<unknown>) =>
  parts.some(
    (part) =>
      part === null ||
      typeof part !== "object" ||
      !("type" in part) ||
      (part.type !== "text" && part.type !== "reasoning"),
  );
