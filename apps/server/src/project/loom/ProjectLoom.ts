import {
  LOOM_COMMAND_PREVIEW_CHARS,
  LOOM_DEFAULT_WINDOW_MS,
  LOOM_LIMITS,
  LOOM_MAX_WINDOW_MS,
  LoomWindow,
  ProjectLoomError,
  type LoomFilters,
  type LoomRunStatusFilter,
  type LoomWindowInput,
  type OrchestrationV2RunStatus,
  type ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { recognizeTestCommand } from "./testCommands.ts";

// Command items examined per page for test recognition; newest first.
const COMMAND_CANDIDATE_LIMIT = 4_000;
const COMMAND_SCAN_CHARS = 600;

const STATUS_BUCKETS: Record<LoomRunStatusFilter, ReadonlyArray<OrchestrationV2RunStatus>> = {
  active: ["preparing", "queued", "starting", "running", "waiting"],
  completed: ["completed"],
  failed: ["failed"],
  interrupted: ["interrupted", "cancelled", "rolled_back"],
};

export class ProjectLoom extends Context.Service<
  ProjectLoom,
  {
    readonly readWindow: (input: LoomWindowInput) => Effect.Effect<LoomWindow, ProjectLoomError>;
  }
>()("t3/project/loom/ProjectLoom") {}

interface ResolvedWindow {
  readonly from: string;
  readonly to: string;
}

const epochMillis = (value: string) =>
  Option.match(DateTime.make(value), { onNone: () => Number.NaN, onSome: DateTime.toEpochMillis });
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** Defaults to the seven days ending now and never spans more than LOOM_MAX_WINDOW_MS. */
function resolveLoomWindow(
  input: Pick<LoomWindowInput, "from" | "to">,
  nowMs: number,
): ResolvedWindow | null {
  const toMs = input.to === undefined ? nowMs : epochMillis(input.to);
  const requestedFromMs =
    input.from === undefined ? toMs - LOOM_DEFAULT_WINDOW_MS : epochMillis(input.from);
  if (!Number.isFinite(toMs) || !Number.isFinite(requestedFromMs) || requestedFromMs >= toMs) {
    return null;
  }
  const fromMs = Math.max(requestedFromMs, toMs - LOOM_MAX_WINDOW_MS);
  return { from: isoAt(fromMs), to: isoAt(toMs) };
}

function normalizedFilters(filters: LoomFilters | undefined) {
  const sorted = <T extends string>(values: ReadonlyArray<T> | undefined) =>
    values === undefined || values.length === 0 ? undefined : [...new Set(values)].toSorted();
  const title = filters?.title?.trim();
  return {
    title: title === undefined || title.length === 0 ? undefined : title.toLowerCase(),
    statuses: sorted(filters?.statuses),
    providerInstanceIds: sorted(filters?.providerInstanceIds),
    models: sorted(filters?.models),
    branches: sorted(filters?.branches),
  };
}
type NormalizedFilters = ReturnType<typeof normalizedFilters>;

// FNV-1a: a cursor only has to notice that its window or filters changed, not resist forgery.
function bindingKey(window: ResolvedWindow, filters: NormalizedFilters): string {
  const text = JSON.stringify([window.from, window.to, filters]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

const LaneCursor = Schema.Struct({ k: Schema.String, c: Schema.String, t: Schema.String });
type LaneCursor = typeof LaneCursor.Type;
const decodeLaneCursor = Schema.decodeUnknownOption(Schema.fromJsonString(LaneCursor));

const encodeCursor = (cursor: LaneCursor) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decodeCursor = (cursor: string) =>
  decodeLaneCursor(Buffer.from(cursor, "base64url").toString("utf8"));

const ACTIVE_STATUSES = JSON.stringify(STATUS_BUCKETS.active);
const ids = (values: ReadonlyArray<string>) => JSON.stringify(values);
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

interface LaneRow {
  readonly thread_id: string;
  readonly title: string;
  readonly provider_instance_id: string | null;
  readonly default_provider: string;
  readonly created_at: string;
  readonly archived_at: string | null;
  readonly parent_thread_id: string | null;
  readonly relationship: string | null;
  readonly model: string | null;
  readonly branch: string | null;
  readonly pull_requests: string | null;
}

interface PullRequestLinkJson {
  readonly host?: string;
  readonly repository?: string;
  readonly number?: number;
  readonly url?: string;
  readonly source?: string;
  readonly linkedAt?: string;
  readonly snapshot?: { readonly title?: string } | null;
}

const relationshipOf = (row: Pick<LaneRow, "relationship">) =>
  row.relationship === "fork" || row.relationship === "subagent" ? row.relationship : "root";

const laneIdentity = (row: LaneRow) => ({
  threadId: row.thread_id,
  title: row.title,
  relationship: relationshipOf(row),
  parentThreadId: row.parent_thread_id,
});

const decodeWindow = Schema.decodeUnknownEffect(LoomWindow);
const isProjectLoomError = Schema.is(ProjectLoomError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const laneColumns = sql`
    t.thread_id, t.title, t.provider_instance_id, t.default_provider, t.created_at, t.archived_at,
    json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
    json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship,
    json_extract(t.payload_json, '$.modelSelection.model') AS model,
    json_extract(t.payload_json, '$.branch') AS branch
  `;

  // A run with no completion time overlaps only while it is still active; a finished run whose
  // end was never recorded is placed by its request time alone.
  const runOverlaps = (window: ResolvedWindow, alias: string) => {
    const run = sql.literal(alias);
    return sql`
      ${run}.requested_at <= ${window.to}
      AND (
        ${run}.completed_at >= ${window.from}
        OR (${run}.completed_at IS NULL AND (
          ${run}.requested_at >= ${window.from}
          OR ${run}.status IN (SELECT value FROM json_each(${ACTIVE_STATUSES}))
        ))
      )
    `;
  };

  const runFilter = (filters: NormalizedFilters, alias: string) => {
    const run = sql.literal(alias);
    const statuses = filters.statuses?.flatMap((bucket) => STATUS_BUCKETS[bucket]);
    return sql`
      ${statuses === undefined ? sql`` : sql`AND ${run}.status IN (SELECT value FROM json_each(${ids(statuses)}))`}
      ${filters.providerInstanceIds === undefined ? sql`` : sql`AND ${run}.provider_instance_id IN (SELECT value FROM json_each(${ids(filters.providerInstanceIds)}))`}
      ${filters.models === undefined ? sql`` : sql`AND json_extract(${run}.payload_json, '$.modelSelection.model') IN (SELECT value FROM json_each(${ids(filters.models)}))`}
    `;
  };

  const hasRunFilter = (filters: NormalizedFilters) =>
    filters.statuses !== undefined ||
    filters.providerInstanceIds !== undefined ||
    filters.models !== undefined;

  // Every projected thread event advances the thread's updated_at, so a thread untouched since
  // the window opened has nothing in it.
  const readLanes = (
    projectId: ProjectId,
    window: ResolvedWindow,
    filters: NormalizedFilters,
    after: LaneCursor | null,
  ) => sql<LaneRow>`
    SELECT ${laneColumns}, json_extract(t.payload_json, '$.pullRequests') AS pull_requests
    FROM orchestration_v2_projection_threads t
    WHERE t.project_id = ${projectId}
      AND t.deleted_at IS NULL
      AND t.created_at <= ${window.to}
      AND t.updated_at >= ${window.from}
      AND (
        t.created_at >= ${window.from}
        OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs r
          WHERE r.thread_id = t.thread_id AND ${runOverlaps(window, "r")}
        )
      )
      ${filters.title === undefined ? sql`` : sql`AND instr(lower(t.title), ${filters.title}) > 0`}
      ${filters.branches === undefined ? sql`` : sql`AND json_extract(t.payload_json, '$.branch') IN (SELECT value FROM json_each(${ids(filters.branches)}))`}
      ${
        hasRunFilter(filters)
          ? sql`AND EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs fr
              WHERE fr.thread_id = t.thread_id AND ${runOverlaps(window, "fr")} ${runFilter(filters, "fr")}
            )`
          : sql``
      }
      ${after === null ? sql`` : sql`AND (t.created_at < ${after.c} OR (t.created_at = ${after.c} AND t.thread_id < ${after.t}))`}
    ORDER BY t.created_at DESC, t.thread_id DESC
    LIMIT ${LOOM_LIMITS.lanes + 1}
  `;

  // Walks up lineage for parents not on this page. Deleted or other-project parents stay absent.
  const readAncestors = Effect.fn("ProjectLoom.readAncestors")(function* (
    projectId: ProjectId,
    lanes: ReadonlyArray<LaneRow>,
  ) {
    const known = new Set(lanes.map((lane) => lane.thread_id));
    const ancestors: Array<LaneRow> = [];
    let wanted = lanes.flatMap((lane) => lane.parent_thread_id ?? []);
    let truncated = false;
    while (wanted.length > 0) {
      const next = [...new Set(wanted)].filter((id) => !known.has(id));
      if (next.length === 0) break;
      for (const id of next) known.add(id);
      const rows = yield* sql<LaneRow>`
        SELECT ${laneColumns}, NULL AS pull_requests
        FROM orchestration_v2_projection_threads t
        WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL
          AND t.thread_id IN (SELECT value FROM json_each(${ids(next)}))
        ORDER BY t.created_at DESC, t.thread_id DESC
      `;
      const room = LOOM_LIMITS.ancestors - ancestors.length;
      if (rows.length > room) truncated = true;
      ancestors.push(...rows.slice(0, room));
      if (truncated) break;
      wanted = rows.flatMap((row) => row.parent_thread_id ?? []);
    }
    return { ancestors, truncated };
  });

  const readRuns = (
    laneIds: ReadonlyArray<string>,
    window: ResolvedWindow,
    filters: NormalizedFilters,
  ) => sql<{
    readonly run_id: string;
    readonly thread_id: string;
    readonly ordinal: number;
    readonly status: string;
    readonly provider_instance_id: string | null;
    readonly provider: string;
    readonly model: string | null;
    readonly user_message_id: string;
    readonly requested_at: string;
    readonly started_at: string | null;
    readonly completed_at: string | null;
  }>`
    SELECT
      r.run_id, r.thread_id, r.ordinal, r.status, r.provider_instance_id, r.provider,
      json_extract(r.payload_json, '$.modelSelection.model') AS model,
      json_extract(r.payload_json, '$.userMessageId') AS user_message_id,
      r.requested_at,
      json_extract(r.payload_json, '$.startedAt') AS started_at,
      r.completed_at
    FROM orchestration_v2_projection_runs r
    WHERE r.thread_id IN (SELECT value FROM json_each(${ids(laneIds)}))
      AND ${runOverlaps(window, "r")}
      ${runFilter(filters, "r")}
    ORDER BY r.requested_at DESC, r.run_id DESC
    LIMIT ${LOOM_LIMITS.runs + 1}
  `;

  const readCheckpoints = (laneIds: ReadonlyArray<string>, window: ResolvedWindow) => sql<{
    readonly checkpoint_id: string;
    readonly thread_id: string;
    readonly run_id: string | null;
    readonly status: string;
    readonly captured_at: string;
    readonly file_count: number;
    readonly additions: number;
    readonly deletions: number;
  }>`
    SELECT
      c.checkpoint_id, c.thread_id, c.run_id, c.status, c.captured_at,
      COALESCE(json_array_length(c.payload_json, '$.files'), 0) AS file_count,
      (SELECT COALESCE(SUM(json_extract(f.value, '$.additions')), 0) FROM json_each(c.payload_json, '$.files') f) AS additions,
      (SELECT COALESCE(SUM(json_extract(f.value, '$.deletions')), 0) FROM json_each(c.payload_json, '$.files') f) AS deletions
    FROM orchestration_v2_projection_checkpoints c
    WHERE c.thread_id IN (SELECT value FROM json_each(${ids(laneIds)}))
      AND c.captured_at >= ${window.from} AND c.captured_at <= ${window.to}
    ORDER BY c.captured_at DESC, c.checkpoint_id DESC
    LIMIT ${LOOM_LIMITS.markers + 1}
  `;

  // The inner LIMIT bounds the rows whose payload is parsed; output is never read.
  const readCommands = (runIds: ReadonlyArray<string>) => sql<{
    readonly turn_item_id: string;
    readonly thread_id: string;
    readonly run_id: string | null;
    readonly started_at: string | null;
    readonly completed_at: string | null;
    readonly exit_code: number | null;
    readonly input: string | null;
  }>`
    SELECT
      candidate.turn_item_id, candidate.thread_id, candidate.run_id,
      json_extract(candidate.payload_json, '$.startedAt') AS started_at,
      json_extract(candidate.payload_json, '$.completedAt') AS completed_at,
      json_extract(candidate.payload_json, '$.exitCode') AS exit_code,
      substr(json_extract(candidate.payload_json, '$.input'), 1, ${COMMAND_SCAN_CHARS}) AS input
    FROM (
      SELECT turn_item_id, thread_id, run_id, payload_json
      FROM orchestration_v2_projection_turn_items
      WHERE run_id IN (SELECT value FROM json_each(${ids(runIds)}))
        AND type = 'command_execution'
      ORDER BY updated_at DESC, turn_item_id DESC
      LIMIT ${COMMAND_CANDIDATE_LIMIT + 1}
    ) candidate
  `;

  const readNativeTasks = (laneIds: ReadonlyArray<string>, window: ResolvedWindow) => sql<{
    readonly subagent_id: string;
    readonly thread_id: string;
    readonly run_id: string | null;
    readonly status: string;
    readonly started_at: string | null;
    readonly completed_at: string | null;
    readonly title: string | null;
  }>`
    SELECT s.subagent_id, s.thread_id, s.run_id, s.status, s.started_at, s.completed_at,
      json_extract(s.payload_json, '$.title') AS title
    FROM orchestration_v2_projection_subagents s
    WHERE s.thread_id IN (SELECT value FROM json_each(${ids(laneIds)}))
      AND s.child_thread_id IS NULL
      AND (
        (s.started_at >= ${window.from} AND s.started_at <= ${window.to})
        OR (s.started_at IS NULL AND s.updated_at >= ${window.from} AND s.updated_at <= ${window.to})
      )
    ORDER BY s.started_at DESC, s.subagent_id DESC
    LIMIT ${LOOM_LIMITS.markers + 1}
  `;

  // Both endpoints must belong to the project, so an edge never names another project's thread.
  const readEdges = (
    projectId: ProjectId,
    laneIds: ReadonlyArray<string>,
    window: ResolvedWindow,
  ) => sql<{
    readonly context_transfer_id: string;
    readonly type: string;
    readonly source_thread_id: string;
    readonly target_thread_id: string;
    readonly source_run_id: string | null;
    readonly target_run_id: string | null;
    readonly created_at: string;
    readonly status: string;
  }>`
    SELECT x.context_transfer_id, x.type, x.source_thread_id, x.target_thread_id,
      json_extract(x.payload_json, '$.sourcePoint.runId') AS source_run_id,
      x.target_run_id, x.created_at, x.status
    FROM (
      SELECT ct.*, json_extract(ct.payload_json, '$.createdAt') AS created_at
      FROM orchestration_v2_projection_context_transfers ct
      WHERE ct.source_thread_id IN (SELECT value FROM json_each(${ids(laneIds)}))
         OR ct.target_thread_id IN (SELECT value FROM json_each(${ids(laneIds)}))
    ) x
    WHERE x.created_at >= ${window.from} AND x.created_at <= ${window.to}
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_threads s
        WHERE s.thread_id = x.source_thread_id AND s.project_id = ${projectId} AND s.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_threads d
        WHERE d.thread_id = x.target_thread_id AND d.project_id = ${projectId} AND d.deleted_at IS NULL)
    ORDER BY x.created_at DESC, x.context_transfer_id DESC
    LIMIT ${LOOM_LIMITS.edges + 1}
  `;

  const readWindow = Effect.fn("ProjectLoom.readWindow")(function* (input: LoomWindowInput) {
    const { projectId } = input;
    const project = yield* projects.get(projectId);
    if (Option.isNone(project) || project.value.deletedAt !== null) {
      return yield* new ProjectLoomError({ reason: "missing_project", projectId });
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const window = resolveLoomWindow(input, nowMs);
    if (window === null)
      return yield* new ProjectLoomError({ reason: "invalid_window", projectId });
    const filters = normalizedFilters(input.filters);
    const key = bindingKey(window, filters);
    let after: LaneCursor | null = null;
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor);
      if (Option.isNone(cursor) || cursor.value.k !== key) {
        return yield* new ProjectLoomError({ reason: "invalid_cursor", projectId });
      }
      after = cursor.value;
    }

    const laneRows = yield* readLanes(projectId, window, filters, after);
    const lanes = laneRows.slice(0, LOOM_LIMITS.lanes);
    const lastLane = lanes.at(-1);
    const nextCursor =
      laneRows.length > LOOM_LIMITS.lanes && lastLane !== undefined
        ? encodeCursor({ k: key, c: lastLane.created_at, t: lastLane.thread_id })
        : null;
    const laneIds = lanes.map((lane) => lane.thread_id);
    const ancestors = yield* readAncestors(projectId, lanes);

    const runRows = yield* readRuns(laneIds, window, filters);
    const runs = runRows.slice(0, LOOM_LIMITS.runs);
    const runIds = runs.map((run) => run.run_id);
    const [checkpoints, commandRows, tasks, edgeRows] = yield* Effect.all([
      readCheckpoints(laneIds, window),
      readCommands(runIds),
      readNativeTasks(laneIds, window),
      readEdges(projectId, laneIds, window),
    ]);

    const inWindow = (at: string) => at >= window.from && at <= window.to;
    const pullRequestMarkers = lanes.flatMap((lane) => {
      if (lane.pull_requests === null) return [];
      const links: ReadonlyArray<PullRequestLinkJson> = JSON.parse(lane.pull_requests);
      return links.flatMap((link) =>
        link.linkedAt === undefined ||
        !inWindow(link.linkedAt) ||
        link.url === undefined ||
        link.repository === undefined ||
        link.number === undefined
          ? []
          : [
              {
                kind: "pull_request" as const,
                id: `${link.host ?? ""}/${link.repository}#${link.number}`,
                threadId: lane.thread_id,
                runId: null,
                at: link.linkedAt,
                repository: link.repository,
                number: link.number,
                url: link.url,
                source: link.source,
                title: link.snapshot?.title ?? null,
              },
            ],
      );
    });
    const commandCandidates = commandRows.slice(0, COMMAND_CANDIDATE_LIMIT);
    const testMarkers = commandCandidates.flatMap((row) => {
      const at = row.started_at ?? row.completed_at;
      const command = row.input === null ? null : recognizeTestCommand(row.input);
      return at === null || command === null || !inWindow(at)
        ? []
        : [
            {
              kind: "test_command" as const,
              id: row.turn_item_id,
              threadId: row.thread_id,
              runId: row.run_id,
              at,
              completedAt: row.completed_at,
              command: command.slice(0, LOOM_COMMAND_PREVIEW_CHARS),
              exitCode: row.exit_code,
            },
          ];
    });
    const timedTasks = tasks.flatMap((task) =>
      task.started_at === null
        ? []
        : [
            {
              kind: "subagent_task" as const,
              id: task.subagent_id,
              threadId: task.thread_id,
              runId: task.run_id,
              at: task.started_at,
              completedAt: task.completed_at,
              status: task.status,
              title: task.title,
            },
          ],
    );
    const checkpointMarkers = checkpoints.map((checkpoint) => ({
      kind: "checkpoint" as const,
      id: checkpoint.checkpoint_id,
      threadId: checkpoint.thread_id,
      runId: checkpoint.run_id,
      at: checkpoint.captured_at,
      status: checkpoint.status,
      fileCount: checkpoint.file_count,
      additions: checkpoint.additions,
      deletions: checkpoint.deletions,
    }));
    const allMarkers = [
      ...checkpointMarkers,
      ...pullRequestMarkers,
      ...testMarkers,
      ...timedTasks,
    ].toSorted((left, right) =>
      left.at === right.at ? (left.id < right.id ? 1 : -1) : left.at < right.at ? 1 : -1,
    );

    let markers = allMarkers.slice(0, LOOM_LIMITS.markers);
    let runEntries = runs.map((run) => ({
      id: run.run_id,
      threadId: run.thread_id,
      ordinal: run.ordinal,
      status: run.status,
      providerInstanceId: run.provider_instance_id ?? run.provider,
      model: run.model ?? "",
      userMessageId: run.user_message_id,
      requestedAt: run.requested_at,
      startedAt: run.started_at,
      completedAt: run.completed_at,
    }));
    let edges = edgeRows.slice(0, LOOM_LIMITS.edges).map((edge) => ({
      id: edge.context_transfer_id,
      type: edge.type,
      sourceThreadId: edge.source_thread_id,
      targetThreadId: edge.target_thread_id,
      sourceRunId: edge.source_run_id,
      targetRunId: edge.target_run_id,
      at: edge.created_at,
      status: edge.status,
    }));
    const base = {
      projectId,
      asOf: isoAt(nowMs),
      from: window.from,
      to: window.to,
      lanes: lanes.map((lane) => ({
        ...laneIdentity(lane),
        providerInstanceId: lane.provider_instance_id ?? lane.default_provider,
        model: lane.model ?? "",
        branch: lane.branch,
        createdAt: lane.created_at,
        archivedAt: lane.archived_at,
      })),
      ancestors: ancestors.ancestors.map(laneIdentity),
      coverage: {
        untimedTasks: tasks.length - timedTasks.length,
        commandsScanned: commandCandidates.length,
        commandsTruncated: commandRows.length > COMMAND_CANDIDATE_LIMIT,
      },
      nextCursor,
    };

    // Oldest marks go first, then oldest runs, then oldest edges; lanes always fit.
    let bytesTruncated = false;
    const size = () => byteLength({ ...base, markers, runs: runEntries, edges });
    while (size() > LOOM_LIMITS.bytes) {
      bytesTruncated = true;
      if (markers.length > 0) markers = markers.slice(0, Math.floor(markers.length * 0.8));
      else if (runEntries.length > 0)
        runEntries = runEntries.slice(0, Math.floor(runEntries.length * 0.8));
      else if (edges.length > 0) edges = edges.slice(0, Math.floor(edges.length * 0.8));
      else break;
    }

    return yield* decodeWindow({
      ...base,
      markers,
      runs: runEntries,
      edges,
      truncated: {
        lanes: nextCursor !== null,
        ancestors: ancestors.truncated,
        runs: runRows.length > LOOM_LIMITS.runs,
        markers:
          allMarkers.length > LOOM_LIMITS.markers || checkpoints.length > LOOM_LIMITS.markers,
        edges: edgeRows.length > LOOM_LIMITS.edges,
        bytes: bytesTruncated,
      },
    });
  });

  return {
    readWindow: (input: LoomWindowInput) =>
      readWindow(input).pipe(
        Effect.mapError((cause) =>
          isProjectLoomError(cause)
            ? cause
            : new ProjectLoomError({ reason: "storage", projectId: input.projectId, cause }),
        ),
      ),
  };
});

export const layer = Layer.effect(ProjectLoom, make);
