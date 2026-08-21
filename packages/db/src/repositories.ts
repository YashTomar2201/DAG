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
