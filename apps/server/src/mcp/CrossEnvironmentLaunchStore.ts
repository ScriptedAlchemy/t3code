import {
  CommandId,
  CrossEnvironmentLaunchDestination,
  CrossEnvironmentLaunchResult,
  CrossEnvironmentRequestConflict,
  type CrossEnvironmentLaunchAsk,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class CrossEnvironmentLaunchStoreError extends Schema.TaggedError<CrossEnvironmentLaunchStoreError>()(
  "CrossEnvironmentLaunchStoreError",
  {
    operation: Schema.Literals(["reserve", "claim", "complete"]),
    commandId: CommandId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} cross-environment launch ${this.commandId}.`;
  }
}

const LaunchRecord = Schema.Struct({
  requestHash: Schema.String,
  destination: Schema.NullOr(Schema.fromJsonString(CrossEnvironmentLaunchDestination)),
  result: Schema.NullOr(Schema.fromJsonString(CrossEnvironmentLaunchResult)),
});
type LaunchRecord = typeof LaunchRecord.Type;
const decodeRecord = Schema.decodeUnknownEffect(LaunchRecord);
const decodeDestination = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CrossEnvironmentLaunchDestination),
);
const decodeResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CrossEnvironmentLaunchResult),
);
const encodeRequest = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);
const encodeDestination = Schema.encodeEffect(
  Schema.fromJsonString(CrossEnvironmentLaunchDestination),
);
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(CrossEnvironmentLaunchResult));

export class CrossEnvironmentLaunchStore extends Context.Service<
  CrossEnvironmentLaunchStore,
  {
    readonly reserve: (
      ask: CrossEnvironmentLaunchAsk,
    ) => Effect.Effect<
      LaunchRecord,
      CrossEnvironmentLaunchStoreError | CrossEnvironmentRequestConflict
    >;
    readonly claim: (
      commandId: CommandId,
      destination: CrossEnvironmentLaunchDestination,
    ) => Effect.Effect<CrossEnvironmentLaunchDestination, CrossEnvironmentLaunchStoreError>;
    readonly complete: (
      commandId: CommandId,
      result: CrossEnvironmentLaunchResult,
    ) => Effect.Effect<CrossEnvironmentLaunchResult, CrossEnvironmentLaunchStoreError>;
  }
>()("t3/mcp/CrossEnvironmentLaunchStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const reserve = Effect.fn("CrossEnvironmentLaunchStore.reserve")(function* (
    ask: CrossEnvironmentLaunchAsk,
  ) {
    const record = yield* Effect.gen(function* () {
      const request = yield* encodeRequest([
        ask.callerEnvironmentId,
        ask.sourceProjectId,
        ask.threadId,
        ask.target.kind,
        ask.target.kind === "environment" ? ask.target.environmentId : null,
        ask.kind,
        ask.title,
        ask.message ?? null,
        ask.runtimeMode,
        ask.interactionMode,
      ]);
      const requestHash = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(request))
        .pipe(Effect.map(Hex.encode));
      yield* sql`
        INSERT INTO cross_environment_launches (command_id, request_hash)
        VALUES (${ask.commandId}, ${requestHash})
        ON CONFLICT(command_id) DO NOTHING
      `;
      const rows = yield* sql`
        SELECT request_hash AS requestHash, destination_json AS destination, result_json AS result
        FROM cross_environment_launches WHERE command_id = ${ask.commandId}
      `;
      return { record: yield* decodeRecord(rows[0]), requestHash };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CrossEnvironmentLaunchStoreError({
            operation: "reserve",
            commandId: ask.commandId,
            cause,
          }),
      ),
    );
    if (record.record.requestHash !== record.requestHash) {
      return yield* new CrossEnvironmentRequestConflict({ commandId: ask.commandId });
    }
    return record.record;
  });

  const claim = Effect.fn("CrossEnvironmentLaunchStore.claim")(
    function* (commandId: CommandId, destination: CrossEnvironmentLaunchDestination) {
      const encoded = yield* encodeDestination(destination);
      const rows = yield* sql<{ readonly destination: string }>`
      UPDATE cross_environment_launches
      SET destination_json = COALESCE(destination_json, ${encoded})
      WHERE command_id = ${commandId}
      RETURNING destination_json AS destination
    `;
      return yield* decodeDestination(rows[0]?.destination);
    },
    (effect, commandId) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new CrossEnvironmentLaunchStoreError({ operation: "claim", commandId, cause }),
        ),
      ),
  );

  const complete = Effect.fn("CrossEnvironmentLaunchStore.complete")(
    function* (commandId: CommandId, result: CrossEnvironmentLaunchResult) {
      const encoded = yield* encodeResult(result);
      const rows = yield* sql<{ readonly result: string }>`
      UPDATE cross_environment_launches
      SET result_json = COALESCE(result_json, ${encoded})
      WHERE command_id = ${commandId}
        AND json_extract(destination_json, '$.environmentId') = ${result.environmentId}
        AND json_extract(destination_json, '$.projectId') = ${result.projectId}
      RETURNING result_json AS result
    `;
      return yield* decodeResult(rows[0]?.result);
    },
    (effect, commandId) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new CrossEnvironmentLaunchStoreError({ operation: "complete", commandId, cause }),
        ),
      ),
  );

  return CrossEnvironmentLaunchStore.of({ reserve, claim, complete });
});

export const layer = Layer.effect(CrossEnvironmentLaunchStore, make);
