import type { NodeStatus, RunStatus } from '@dag/contracts';
import type { TopologicalSortResult } from '@dag/graph-core';
import type { Graph } from '@dag/contracts';
import { prisma } from './client';
import type { Prisma } from './generated/client';
import type {
  Run,
  NodeRun,
  WorkflowVersion,
  RunEvent,
} from './generated/client';

// Re-export generated types so consumers don't need to import from generated/
export type { Run, NodeRun, WorkflowVersion, RunEvent, Tenant, Workflow } from './generated/client';

// ─── Workflow ────────────────────────────────────────────────────────────────

/**
 * Creates a new Workflow and its first version atomically.
 * Returns the version id — callers store this as a reference for runs.
 */
export async function createWorkflow(
  tenantId: string,
  name: string,
  graph: Graph,
  topoOrder: TopologicalSortResult,
): Promise<{ workflowId: string; versionId: string }> {
  const result = await prisma.$transaction(async (tx) => {
    // Ensure the owning tenant exists before we create a workflow that
    // foreign-keys to it. The single-tenant visual editor always posts a
    // fixed tenant id ("default"); upserting here means a freshly-migrated
    // database needs no separate seed step and `POST /workflows` never fails
    // with a Workflow_tenantId_fkey violation.
    await tx.tenant.upsert({
      where: { id: tenantId },
      update: {},
      create: { id: tenantId, name: tenantId === 'default' ? 'Default' : tenantId },
    });

    const workflow = await tx.workflow.create({
      data: { tenantId, name },
    });

    const version = await tx.workflowVersion.create({
      data: {
        workflowId: workflow.id,
        version: 1,
        // Prisma's Json type expects `InputJsonValue` — casting through unknown is the correct pattern
        graph: graph as unknown as Prisma.InputJsonValue,
        topoOrder: topoOrder as unknown as Prisma.InputJsonValue,
      },
    });

    return { workflowId: workflow.id, versionId: version.id };
  });

  return result;
}

/**
 * Appends a new immutable version to an existing workflow.
 * Editing a live graph does NOT mutate existing versions — it creates version N+1.
 * In-progress runs continue to reference their pinned version.
 */
export async function createWorkflowVersion(
  workflowId: string,
  graph: Graph,
  topoOrder: TopologicalSortResult,
): Promise<WorkflowVersion> {
  // Determine the next version number atomically
  return prisma.$transaction(async (tx) => {
    const latest = await tx.workflowVersion.findFirst({
      where: { workflowId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const nextVersion = (latest?.version ?? 0) + 1;

    return tx.workflowVersion.create({
      data: {
        workflowId,
        version: nextVersion,
        graph: graph as unknown as Prisma.InputJsonValue,
        topoOrder: topoOrder as unknown as Prisma.InputJsonValue,
      },
    });
  });
}

// ─── Workflow CRUD (D1.1) ────────────────────────────────────────────────────

export interface WorkflowListRow {
  id: string;
  name: string;
  createdAt: Date;
  versionCount: number;
  /** The most recent `Run.startedAt` across all versions; null if never run. */
  lastRunAt: Date | null;
}

/**
 * Tenant-scoped, newest-first, cursor-paginated list of workflows.
 *
 * `versionCount` and `lastRunAt` are computed in ONE extra query (a
 * `workflowVersion.findMany` that also pulls each version's most-recent run),
 * not one query per row.
 */
export async function listWorkflows(
  tenantId: string,
  opts: { limit: number; cursor?: string },
): Promise<{ workflows: WorkflowListRow[]; nextCursor: string | null }> {
  const rows = await prisma.workflow.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: { id: true, name: true, createdAt: true },
  });

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const ids = page.map((w) => w.id);

  const agg = ids.length
    ? await prisma.workflowVersion.findMany({
        where: { workflowId: { in: ids } },
        select: {
          workflowId: true,
          runs: { select: { startedAt: true }, orderBy: { startedAt: 'desc' }, take: 1 },
        },
      })
    : [];

  const versionCount = new Map<string, number>();
  const lastRunAt = new Map<string, Date | null>();
  for (const v of agg) {
    versionCount.set(v.workflowId, (versionCount.get(v.workflowId) ?? 0) + 1);
    const started = v.runs[0]?.startedAt ?? null;
    const cur = lastRunAt.get(v.workflowId) ?? null;
    if (started && (!cur || started > cur)) lastRunAt.set(v.workflowId, started);
  }

  return {
    workflows: page.map((w) => ({
      id: w.id,
      name: w.name,
      createdAt: w.createdAt,
      versionCount: versionCount.get(w.id) ?? 0,
      lastRunAt: lastRunAt.get(w.id) ?? null,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}

/** A single workflow with its version list (newest first). 404s if soft-deleted. */
export async function getWorkflowWithVersions(id: string, tenantId: string) {
  return prisma.workflow.findFirst({
    where: { id, tenantId, deletedAt: null },
    select: {
      id: true,
      name: true,
      createdAt: true,
      versions: {
        orderBy: { version: 'desc' },
        select: { id: true, version: true, createdAt: true },
      },
    },
  });
}

/**
 * One full version (graph + topoOrder) of a workflow, tenant-scoped. Null if
 * the workflow is missing / soft-deleted / wrong tenant, or the version id
 * doesn't belong to it.
 */
export async function getWorkflowVersion(workflowId: string, versionId: string, tenantId: string) {
  const wf = await prisma.workflow.findFirst({
    where: { id: workflowId, tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!wf) return null;
  return prisma.workflowVersion.findFirst({
    where: { id: versionId, workflowId },
    select: { id: true, workflowId: true, version: true, graph: true, topoOrder: true, createdAt: true },
  });
}

/** Just the version list for a workflow (D1.3). Returns null if not found. */
export async function listWorkflowVersions(id: string, tenantId: string) {
  const wf = await prisma.workflow.findFirst({
    where: { id, tenantId, deletedAt: null },
    select: {
      versions: {
        orderBy: { version: 'desc' },
        select: { id: true, version: true, createdAt: true },
      },
    },
  });
  return wf ? wf.versions : null;
}

/**
 * Renames a workflow. Returns the updated row, or null if it doesn't exist
 * for this tenant (or is soft-deleted).
 */
export async function renameWorkflow(id: string, tenantId: string, name: string) {
  const result = await prisma.workflow.updateMany({
    where: { id, tenantId, deletedAt: null },
    data: { name },
  });
  if (result.count === 0) return null;
  return prisma.workflow.findUnique({
    where: { id },
    select: { id: true, name: true, createdAt: true },
  });
}

/**
 * Soft-deletes a workflow (sets `deletedAt`). Idempotent-ish: returns false if
 * there was no matching non-deleted row. Runs stay readable by id.
 */
export async function softDeleteWorkflow(id: string, tenantId: string): Promise<boolean> {
  const result = await prisma.workflow.updateMany({
    where: { id, tenantId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return result.count > 0;
}

// ─── Run ─────────────────────────────────────────────────────────────────────

/**
 * Creates a Run and seeds one PENDING NodeRun row per node in a single transaction.
 *
 * Idempotency: if `idempotencyKey` is provided and a Run with that key already
 * exists, returns the existing run (never creates a duplicate).
 *
 * Seeding all NodeRuns in the same transaction as the Run row means the scheduler
 * sees a consistent set of rows to work with immediately.
 */
export async function createRun(
  workflowVersionId: string,
  triggeredBy: string,
  nodeKeys: string[],
  idempotencyKey?: string,
): Promise<Run> {
  // Idempotency check — return existing run without creating a new one
  if (idempotencyKey) {
    const existing = await prisma.run.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;
  }

  return prisma.$transaction(async (tx) => {
    const run = await tx.run.create({
      data: {
        workflowVersionId,
        triggeredBy,
        idempotencyKey,
      },
    });

    // Seed one PENDING NodeRun per node — bulk insert for efficiency
    await tx.nodeRun.createMany({
      data: nodeKeys.map((nodeKey) => ({
        runId: run.id,
        nodeKey,
        // Prisma enums are string-typed in createMany — cast is correct
        status: 'PENDING' as NodeStatus,
        attempt: 0,
      })),
    });

    return run;
  });
}

/** The run created for a given idempotency key, or null. Lets callers tell a
 *  fresh run apart from an idempotent replay (B2 schedule / webhook fires). */
export async function findRunByIdempotencyKey(idempotencyKey: string): Promise<Run | null> {
  return prisma.run.findUnique({ where: { idempotencyKey } });
}

/**
 * Creates one fan-out child run (roadmap B3.2) in a single transaction:
 *   - a `Run` with `parentRunId` / `fanOutIndex` (status PENDING),
 *   - a pre-SUCCEEDED NodeRun for `seedNodeKey` (the `flow.map` node) carrying
 *     the per-element input as its output, so the subgraph can reference it as
 *     `{{ nodes.<seedNodeKey>.output.item }}`,
 *   - one PENDING NodeRun per `subgraphKeys` entry.
 *
 * Idempotent on `idempotencyKey` (`${parentRunId}:${mapNodeKey}:${index}`): a
 * crash mid-spawn that replays returns `{ created: false }` and the existing
 * child, so children can never be double-created.
 */
export async function createFanOutChildRun(params: {
  workflowVersionId: string;
  parentRunId: string;
  fanOutIndex: number;
  subgraphKeys: string[];
  seedNodeKey: string;
  seedOutput: unknown;
  idempotencyKey: string;
}): Promise<{ run: Run; created: boolean }> {
  const existing = await prisma.run.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
  if (existing) return { run: existing, created: false };

  try {
    const run = await prisma.$transaction(async (tx) => {
      const child = await tx.run.create({
        data: {
          workflowVersionId: params.workflowVersionId,
          triggeredBy: 'fanout',
          idempotencyKey: params.idempotencyKey,
          parentRunId: params.parentRunId,
          fanOutIndex: params.fanOutIndex,
        },
      });
      await tx.nodeRun.create({
        data: {
          runId: child.id,
          nodeKey: params.seedNodeKey,
          status: 'SUCCEEDED' as NodeStatus,
          attempt: 0,
          output: params.seedOutput as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });
      if (params.subgraphKeys.length > 0) {
        await tx.nodeRun.createMany({
          data: params.subgraphKeys.map((nodeKey) => ({
            runId: child.id,
            nodeKey,
            status: 'PENDING' as NodeStatus,
            attempt: 0,
          })),
        });
      }
      return child;
    });
    return { run, created: true };
  } catch (err) {
    // A concurrent spawn of the same index lost the unique-key race — return theirs.
    const raced = await prisma.run.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
    if (raced) return { run: raced, created: false };
    throw err;
  }
}

/** Count of a parent's children that are not in a terminal RunStatus. Zero ⇒ join. */
export async function countNonTerminalChildren(parentRunId: string): Promise<number> {
  return prisma.run.count({
    where: { parentRunId, status: { notIn: ['SUCCEEDED', 'FAILED', 'CANCELLED'] } },
  });
}

/** Minimal parent-tree fields for a run, or null if the run doesn't exist. */
export async function getRunTreeInfo(
  runId: string,
): Promise<{ parentRunId: string | null; fanOutIndex: number | null; idempotencyKey: string | null; status: string } | null> {
  return prisma.run.findUnique({
    where: { id: runId },
    select: { parentRunId: true, fanOutIndex: true, idempotencyKey: true, status: true },
  });
}

/**
 * Every fan-out child's sink-node output(s), ordered by `fanOutIndex` (roadmap
 * B3.3). One `run.findMany` + one `nodeRun.findMany` regardless of child count.
 * `element` is the sink's output when the subgraph has a single sink, else a
 * `{ [sinkKey]: output }` map; `null` when the child did not succeed.
 */
export async function getFanOutChildOutputs(
  parentRunId: string,
  sinkKeys: string[],
): Promise<Array<{ fanOutIndex: number; status: string; element: unknown }>> {
  const children = await prisma.run.findMany({
    where: { parentRunId },
    orderBy: { fanOutIndex: 'asc' },
    select: { id: true, fanOutIndex: true, status: true },
  });
  if (children.length === 0) return [];

  const nodeRuns = await prisma.nodeRun.findMany({
    where: { runId: { in: children.map((c) => c.id) }, nodeKey: { in: sinkKeys } },
    select: { runId: true, nodeKey: true, status: true, output: true },
  });
  const byRun = new Map<string, Map<string, unknown>>();
  for (const nr of nodeRuns) {
    if (nr.status !== 'SUCCEEDED') continue;
    let m = byRun.get(nr.runId);
    if (!m) byRun.set(nr.runId, (m = new Map()));
    m.set(nr.nodeKey, nr.output);
  }

  const single = sinkKeys.length === 1 ? sinkKeys[0]! : null;
  return children.map((c) => {
    const outs = byRun.get(c.id);
    let element: unknown = null;
    if (outs && outs.size > 0) {
      element = single ? (outs.get(single) ?? null) : Object.fromEntries(outs);
    }
    return { fanOutIndex: c.fanOutIndex ?? 0, status: c.status, element };
  });
}

// ─── Fan-out run tree (roadmap B3) ──────────────────────────────────────────

export interface ChildRunSummary {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

const EMPTY_CHILD_SUMMARY: ChildRunSummary = {
  total: 0, pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0,
};

/**
 * Per-status counts of a run's direct children, from one `groupBy` — never by
 * loading the child rows. Returns an all-zero summary for a run with no
 * children (the common case). `pending` folds PENDING + RUNNING-is-separate:
 * PENDING here is the DB `PENDING` state only; `running` is `RUNNING`.
 */
export async function getChildRunSummary(parentRunId: string): Promise<ChildRunSummary> {
  const rows = await prisma.run.groupBy({
    by: ['status'],
    where: { parentRunId },
    _count: { _all: true },
  });
  const summary: ChildRunSummary = { ...EMPTY_CHILD_SUMMARY };
  for (const row of rows) {
    const n = row._count._all;
    summary.total += n;
    switch (row.status) {
      case 'PENDING': summary.pending += n; break;
      case 'RUNNING': summary.running += n; break;
      case 'SUCCEEDED': summary.succeeded += n; break;
      case 'FAILED': summary.failed += n; break;
      case 'CANCELLED': summary.cancelled += n; break;
      // RunStatus has no SKIPPED; a skipped fan-out branch never creates a Run.
    }
  }
  return summary;
}

/**
 * Cursor-paginated list of a run's direct children, ordered by `fanOutIndex`
 * (the source-array position) then `id`. Lean projection — the drill-in view
 * (B3.5) fetches a child's full detail separately.
 */
export async function listChildRuns(
  parentRunId: string,
  opts: { limit: number; cursor?: string },
): Promise<{
  children: Array<{
    id: string;
    status: string;
    fanOutIndex: number | null;
    triggeredBy: string;
    startedAt: Date | null;
    finishedAt: Date | null;
  }>;
  nextCursor: string | null;
}> {
  const rows = await prisma.run.findMany({
    where: { parentRunId },
    orderBy: [{ fanOutIndex: 'asc' }, { id: 'asc' }],
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      status: true,
      fanOutIndex: true,
      triggeredBy: true,
      startedAt: true,
      finishedAt: true,
    },
  });

  const hasMore = rows.length > opts.limit;
  const children = hasMore ? rows.slice(0, opts.limit) : rows;
  return {
    children,
    nextCursor: hasMore ? children[children.length - 1]!.id : null,
  };
}

// ─── NodeRun state machine ───────────────────────────────────────────────────

/**
 * Conditional status transition. Returns `true` if the update succeeded (i.e.,
 * the row was in the expected `from` state). Returns `false` if another actor
 * already transitioned it (the row is unchanged).
 *
 * This is the ONLY safe way to write a NodeRun status. Never use a blind UPDATE
 * or a read-then-write — those have a lost-update race condition where two workers
 * both read `RUNNING` and both think they get to write `SUCCEEDED`.
 *
 * Pattern: UPDATE NodeRun SET status=$to WHERE id=$id AND status=$from
 *          → if rowCount === 0, another actor won; abort silently.
 */
export async function tryTransitionNodeRun(
  nodeRunId: string,
  from: NodeStatus,
  to: NodeStatus,
  extra?: {
    output?: Prisma.InputJsonValue;
    error?: Prisma.InputJsonValue;
    workerId?: string;
    leaseExpiresAt?: Date | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    attempt?: number;
  },
): Promise<boolean> {
  const result = await prisma.nodeRun.updateMany({
    where: { id: nodeRunId, status: from },
    data: { status: to, ...extra },
  });

  return result.count > 0;
}

/**
 * Convenience overload for finding a NodeRun by (runId, nodeKey) — the logical key.
 */
export async function findNodeRun(
  runId: string,
  nodeKey: string,
): Promise<NodeRun | null> {
  return prisma.nodeRun.findUnique({
    where: { runId_nodeKey: { runId, nodeKey } },
  });
}

/**
 * Stamps `error` on a NodeRun without changing its status (roadmap B5). The
 * worker calls this on every failed attempt so the taxonomy-rich error is on
 * the row before it throws — `onNodeFailed` then preserves it rather than
 * overwriting with the bare BullMQ `failedReason` string.
 */
export async function setNodeRunError(
  nodeRunId: string,
  error: Prisma.InputJsonValue,
): Promise<void> {
  await prisma.nodeRun.update({ where: { id: nodeRunId }, data: { error } });
}

/**
 * Returns all NodeRuns for a run, keyed by nodeKey for O(1) access in the orchestrator.
 */
export async function getNodeRunMap(
  runId: string,
): Promise<Map<string, NodeRun>> {
  const rows = await prisma.nodeRun.findMany({ where: { runId } });
  return new Map(rows.map((r) => [r.nodeKey, r]));
}

// ─── Run status ──────────────────────────────────────────────────────────────

/**
 * Same conditional-update pattern as tryTransitionNodeRun, applied to the Run row.
 */
export async function tryTransitionRun(
  runId: string,
  from: RunStatus,
  to: RunStatus,
  extra?: {
    startedAt?: Date | null;
    finishedAt?: Date | null;
  },
): Promise<boolean> {
  const result = await prisma.run.updateMany({
    where: { id: runId, status: from },
    data: { status: to, ...extra },
  });

  return result.count > 0;
}

/**
 * Checks whether all NodeRuns for a run are in a terminal state.
 * Used by the orchestrator to decide when to mark the Run SUCCEEDED.
 */
export async function allNodeRunsTerminal(runId: string): Promise<boolean> {
  const pending = await prisma.nodeRun.count({
    where: {
      runId,
      status: { notIn: ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'] },
    },
  });
  return pending === 0;
}

// ─── RunEvent (append-only audit log) ───────────────────────────────────────

/**
 * Appends a structured event to the audit log.
 * Also used as the SSE replay source (via cursor on the BigInt id).
 */
export async function appendRunEvent(
  runId: string,
  type: string,
  payload: Prisma.InputJsonValue,
  nodeKey?: string,
): Promise<RunEvent> {
  return prisma.runEvent.create({
    data: { runId, type, payload, nodeKey },
  });
}

/**
 * Fetches events for SSE replay. `afterId` is the Last-Event-ID cursor.
 * Returns events in ascending order so the client replays them in order.
 */
export async function getRunEvents(
  runId: string,
  afterId?: bigint,
): Promise<RunEvent[]> {
  return prisma.runEvent.findMany({
    where: {
      runId,
      ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: 'asc' },
  });
}

// ─── Observability (Phase 12) ─────────────────────────────────────────────────

/**
 * Current count of every NodeRun, grouped by status, across ALL runs.
 * Backs the `dag_node_runs_by_status` Prometheus gauge (apps/api/src/metrics.ts).
 *
 * Recomputed from Postgres on every scrape rather than maintained as a
 * running counter incremented at each transition site: a groupBy COUNT is a
 * few milliseconds against the `@@index([runId, status])`-backed table and
 * can never drift from the DB's actual state, whereas a counter incremented
 * at N call sites (dispatch, success, failure, skip, cancel) would silently
 * go stale the moment one of those sites is refactored and the increment is
 * forgotten.
 */
export async function countNodeRunsByStatus(): Promise<Record<string, number>> {
  const rows = await prisma.nodeRun.groupBy({ by: ['status'], _count: { _all: true } });
  const result: Record<string, number> = {};
  for (const row of rows) result[row.status] = row._count._all;
  return result;
}

/** Same idea as {@link countNodeRunsByStatus}, one row per Run. */
export async function countRunsByStatus(): Promise<Record<string, number>> {
  const rows = await prisma.run.groupBy({ by: ['status'], _count: { _all: true } });
  const result: Record<string, number> = {};
  for (const row of rows) result[row.status] = row._count._all;
  return result;
}

// ─── Schedules & Triggers (roadmap B2) ──────────────────────────────────────

export type { Schedule, Trigger } from './generated/client';

/**
 * The id of a workflow's newest version, or null if it has none / is
 * soft-deleted / belongs to another tenant. Used by the schedule + webhook
 * fire paths, which run "whatever is latest right now".
 */
export async function getLatestVersionId(
  workflowId: string,
  tenantId?: string,
): Promise<string | null> {
  const wf = await prisma.workflow.findFirst({
    where: { id: workflowId, deletedAt: null, ...(tenantId ? { tenantId } : {}) },
    select: {
      versions: { orderBy: { version: 'desc' }, take: 1, select: { id: true } },
    },
  });
  return wf?.versions[0]?.id ?? null;
}

/** True iff the workflow exists, is not soft-deleted, and belongs to the tenant. */
export async function workflowBelongsToTenant(workflowId: string, tenantId: string): Promise<boolean> {
  const wf = await prisma.workflow.findFirst({
    where: { id: workflowId, tenantId, deletedAt: null },
    select: { id: true },
  });
  return wf !== null;
}

// ── Schedule ────────────────────────────────────────────────────────────────

export async function createSchedule(data: {
  workflowId: string;
  cron: string;
  timezone: string;
  nextFireAt: Date | null;
}) {
  return prisma.schedule.create({ data });
}

export async function listSchedulesForWorkflow(workflowId: string) {
  return prisma.schedule.findMany({
    where: { workflowId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function getScheduleById(id: string) {
  return prisma.schedule.findUnique({ where: { id } });
}

/** All enabled schedules across every workflow — used to reconcile BullMQ on API boot. */
export async function listEnabledSchedules() {
  return prisma.schedule.findMany({ where: { enabled: true } });
}

export async function updateSchedule(
  id: string,
  data: Partial<{
    cron: string;
    timezone: string;
    enabled: boolean;
    nextFireAt: Date | null;
    lastRunId: string | null;
    lastFiredAt: Date | null;
  }>,
) {
  const result = await prisma.schedule.updateMany({ where: { id }, data });
  if (result.count === 0) return null;
  return prisma.schedule.findUnique({ where: { id } });
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const result = await prisma.schedule.deleteMany({ where: { id } });
  return result.count > 0;
}

// ── Trigger ─────────────────────────────────────────────────────────────────

export async function createTrigger(data: {
  workflowId: string;
  token: string;
  secret: string;
}) {
  return prisma.trigger.create({ data });
}

export async function listTriggersForWorkflow(workflowId: string) {
  return prisma.trigger.findMany({
    where: { workflowId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function getTriggerByToken(token: string) {
  return prisma.trigger.findUnique({ where: { token } });
}

export async function getTriggerById(id: string) {
  return prisma.trigger.findUnique({ where: { id } });
}

export async function updateTrigger(
  id: string,
  data: Partial<{ enabled: boolean; lastRunId: string | null; lastFiredAt: Date | null }>,
) {
  const result = await prisma.trigger.updateMany({ where: { id }, data });
  if (result.count === 0) return null;
  return prisma.trigger.findUnique({ where: { id } });
}

export async function deleteTrigger(id: string): Promise<boolean> {
  const result = await prisma.trigger.deleteMany({ where: { id } });
  return result.count > 0;
}
