import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ThreadSearch from "../ThreadSearch.ts";
import { CLAUDE_MODEL_SELECTION, CODEX_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:group-publication");
const PEER_TEXT = "PEERMARK prefers an event log";
interface CapturedTurn {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly nativeThreadId: string | null;
}

interface HistoryItem {
  readonly role: string;
  readonly content: ReadonlyArray<{ readonly text: string }>;
}

function fakeAdapter(input: {
  readonly driver: string;
  readonly modelSelection: ModelSelection;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly turns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly injected?: Ref.Ref<ReadonlyArray<HistoryItem>>;
  readonly rollbackCalls: Ref.Ref<number>;
  readonly hold?: {
    readonly runOrdinal: number;
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  const driver = ProviderDriverKind.make(input.driver);
  const instanceId = ProviderInstanceId.make(input.modelSelection.instanceId);
  const unused = (detail: string) =>
    Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          ...(input.injected === undefined
            ? {}
            : {
                injectHistory: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                  Ref.update(input.injected!, (current) => [
                    ...current,
                    ...(historyResponseItems(
                      history.messages,
                      history.context,
                    ) as ReadonlyArray<HistoryItem>),
                  ]).pipe(Effect.as(true)),
              }),
          compactThread: (turnInput) => runtime.startTurn(turnInput),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Effect.yieldNow;
              yield* Ref.update(input.turns, (turns) => [
                ...turns,
                {
                  driver,
                  threadId: turnInput.threadId,
                  text: turnInput.message.text,
                  nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                },
              ]);
              if (turnInput.runOrdinal === input.hold?.runOrdinal) {
                yield* Deferred.succeed(input.hold.started, undefined);
                yield* Deferred.await(input.hold.release);
              }
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              const providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
                {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}`,
                    ),
                    text: `Primary reply ${turnInput.runOrdinal}`,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ];
              for (const event of providerEvents) yield* PubSub.publish(events, event);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unused("readThreadSnapshot"),
          rollbackThread: ({ providerThread }) =>
            Ref.update(input.rollbackCalls, (calls) => calls + 1).pipe(
              Effect.as({ providerThread, providerTurns: [], messages: [], runtimeRequests: [] }),
            ),
          forkThread: () => unused("a publication run must never fork natively"),
        };
        return runtime;
      }),
  };
}

const makeHarness = Effect.fn("GroupPublicationTest.makeHarness")(function* (
  name: string,
  options: {
    /** Omit the primary's injectHistory, so context can only arrive inside the prompt. */
    readonly inlineOnly?: boolean;
    readonly primaryCapabilities?: OrchestrationV2ProviderCapabilities;
    readonly holdRunOrdinal?: number;
  } = {},
) {
  const cwd = yield* checkpointWorkspace(`group-publication-${name}`);
  const turns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
  const injected = yield* Ref.make<ReadonlyArray<HistoryItem>>([]);
  const rollbackCalls = yield* Ref.make(0);
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const registry = ProviderAdapterRegistry.layerFromAdapters([
    fakeAdapter({
      driver: "codex",
      modelSelection: CODEX_MODEL_SELECTION,
      capabilities: options.primaryCapabilities ?? CodexProviderCapabilitiesV2,
      turns,
      rollbackCalls,
      ...(options.inlineOnly ? {} : { injected }),
      ...(options.holdRunOrdinal === undefined
        ? {}
        : { hold: { runOrdinal: options.holdRunOrdinal, started, release } }),
    }),
    fakeAdapter({
      driver: "claudeAgent",
      modelSelection: CLAUDE_MODEL_SELECTION,
      capabilities: ClaudeProviderCapabilitiesV2,
      turns,
      rollbackCalls,
      injected,
    }),
  ]);
  const database = SqlitePersistence.layerMemory;
  const layer = Layer.mergeAll(
    ProviderReplayHarness.layerWithRegistry(
      {
        name: `group-publication-${name}`,
        runtimePolicyOverride: {
          cwd,
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      },
      registry,
      { databaseLayer: database },
    ),
    Layer.mergeAll(ThreadSearch.layer, ProjectStore.layer).pipe(
      Layer.provide(Layer.mergeAll(database, NodeCrypto.layer, NodeServices.layer)),
    ),
  );
  return { turns, injected, rollbackCalls, started, release, layer };
});

const startThread = Effect.fn("GroupPublicationTest.startThread")(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  yield* projects.apply({
    sequence: 0,
    eventId: EventId.make(`created:${projectId}:${threadId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: createdAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Group publication",
      workspaceRoot: "/work/group-publication",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`command:create:${threadId}`),
    threadId,
    projectId,
    createdBy: "user",
    creationSource: "web",
    title: "Group publication",
    modelSelection: CODEX_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
});

const publishPeerReply = Effect.fn("GroupPublicationTest.publishPeerReply")(function* (
  threadId: ThreadId,
  tag: string,
  options: {
    readonly text?: string;
    readonly modelSelection?: ModelSelection;
    readonly status?: "completed" | "interrupted";
    readonly commandTag?: string;
  } = {},
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const modelSelection = options.modelSelection ?? CLAUDE_MODEL_SELECTION;
  return yield* orchestrator.dispatch({
    type: "thread.group.publish",
    commandId: CommandId.make(`command:publish:${threadId}:${options.commandTag ?? tag}`),
    threadId,
    status: options.status ?? "completed",
    text: options.text ?? `${PEER_TEXT} (${tag})`,
    entry: {
      type: "peer_reply",
      seatThreadId: ThreadId.make(`thread:seat:${threadId}`),
      seatRunId: RunId.make(`run:seat:${threadId}:${tag}`),
      speaker: { label: "Astra", model: modelSelection.model },
      modelSelection,
    },
  });
});

describe("group publication runs", () => {
  it.live("records words said elsewhere as a run with no provider turn, once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("record");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = ThreadId.make("thread:group-publication:record");
          yield* startThread(threadId);
          yield* publishPeerReply(threadId, "reply");
          const interrupted = yield* publishPeerReply(threadId, "stopped", {
            status: "interrupted",
          });
          assert.isAbove(interrupted.storedEvents.length, 0);
          const messageId = MessageId.make("message:group-publication:to-peers");
          yield* orchestrator.dispatch({
            type: "thread.group.publish",
            commandId: CommandId.make("command:group-publication:to-peers"),
            threadId,
            status: "completed",
            text: "To the peers only",
            entry: {
              type: "user_to_peers",
              seatThreadIds: [ThreadId.make("thread:seat:one")],
              messageId,
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
          });

          const first = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            first.runs.map((run) => [run.status, run.publication?.type, run.providerThreadId]),
            [
              ["completed", "peer_reply", null],
              ["interrupted", "peer_reply", null],
              ["completed", "user_to_peers", null],
            ],
          );
          assert.deepEqual(first.runs[0]!.modelSelection, CLAUDE_MODEL_SELECTION);
          assert.deepEqual(first.runs[2]!.modelSelection, CODEX_MODEL_SELECTION);
          assert.deepEqual(
            first.turnItems.map((item) =>
              item.type === "assistant_message" ? [item.type, item.speaker] : [item.type, null],
            ),
            [
              ["assistant_message", { label: "Astra", model: CLAUDE_MODEL_SELECTION.model }],
              ["assistant_message", { label: "Astra", model: CLAUDE_MODEL_SELECTION.model }],
              ["user_message", null],
            ],
          );
          assert.equal(first.messages.at(-1)?.id, messageId);

          const repeat = yield* publishPeerReply(threadId, "reply", { commandTag: "repeat" });
          assert.lengthOf(repeat.storedEvents, 0);
          const second = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(second.runs, first.runs);
          assert.deepEqual(second.turnItems, first.turnItems);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );
});
