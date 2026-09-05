import type { NodeStatus, RunStatus } from '@dag/contracts';
import type { TopologicalSortResult } from '@dag/graph-core';
import type { Graph } from '@dag/contracts';
import { prisma } from './client';
import { withTenant, withAdminContext } from './tenant';
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

    // Roadmap C2.1: Workflow is RLS-protected — the INSERT below is checked
    // against this same value (the policy's implicit WITH CHECK).
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

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
  return withTenant(tenantId, async (tx) => {
  const rows = await tx.workflow.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: { id: true, name: true, createdAt: true },
  });

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const ids = page.map((w) => w.id);

  // WorkflowVersion/Run: Run is RLS-protected too, but we're already inside
  // this tenant's transaction, so it's visible the same way Workflow is —
  // no separate wrapping needed for a query nested in the same tx.
  const agg = ids.length
    ? await tx.workflowVersion.findMany({
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
  });
}

/** A single workflow with its version list (newest first). 404s if soft-deleted. */
export async function getWorkflowWithVersions(id: string, tenantId: string) {
  return withTenant(tenantId, (tx) =>
    tx.workflow.findFirst({
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
    }),
  );
}

/**
 * One full version (graph + topoOrder) of a workflow, tenant-scoped. Null if
 * the workflow is missing / soft-deleted / wrong tenant, or the version id
 * doesn't belong to it.
 */
export async function getWorkflowVersion(workflowId: string, versionId: string, tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const wf = await tx.workflow.findFirst({
      where: { id: workflowId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!wf) return null;
    // WorkflowVersion itself isn't RLS-protected (see the migration's doc
    // comment) — scoping through the Workflow check above is what makes this
    // tenant-safe.
    return tx.workflowVersion.findFirst({
      where: { id: versionId, workflowId },
      select: { id: true, workflowId: true, version: true, graph: true, topoOrder: true, createdAt: true },
    });
  });
}

/** Just the version list for a workflow (D1.3). Returns null if not found. */
export async function listWorkflowVersions(id: string, tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const wf = await tx.workflow.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: {
        versions: {
          orderBy: { version: 'desc' },
          select: { id: true, version: true, createdAt: true },
        },
      },
    });
    return wf ? wf.versions : null;
  });
}

/**
 * Renames a workflow. Returns the updated row, or null if it doesn't exist
 * for this tenant (or is soft-deleted).
 */
export async function renameWorkflow(id: string, tenantId: string, name: string) {
  return withTenant(tenantId, async (tx) => {
    const result = await tx.workflow.updateMany({
      where: { id, tenantId, deletedAt: null },
      data: { name },
    });
    if (result.count === 0) return null;
    return tx.workflow.findUnique({
      where: { id },
      select: { id: true, name: true, createdAt: true },
    });
  });
}

/**
 * Soft-deletes a workflow (sets `deletedAt`). Idempotent-ish: returns false if
 * there was no matching non-deleted row. Runs stay readable by id.
 */
export async function softDeleteWorkflow(id: string, tenantId: string): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const result = await tx.workflow.updateMany({
      where: { id, tenantId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return result.count > 0;
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
  tenantId: string,
  triggeredBy: string,
  nodeKeys: string[],
  idempotencyKey?: string,
): Promise<Run> {
  return withTenant(tenantId, async (tx) => {
    // Idempotency check — return existing run without creating a new one
    if (idempotencyKey) {
      const existing = await tx.run.findUnique({ where: { idempotencyKey } });
      if (existing) return existing;
    }

    const run = await tx.run.create({
      data: {
        workflowVersionId,
        tenantId,
        triggeredBy,
        idempotencyKey,
      },
    });

    // Seed one PENDING NodeRun per node — bulk insert for efficiency
    await tx.nodeRun.createMany({
      data: nodeKeys.map((nodeKey) => ({
        runId: run.id,
        tenantId,
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
export async function findRunByIdempotencyKey(idempotencyKey: string, tenantId: string): Promise<Run | null> {
  return withTenant(tenantId, (tx) => tx.run.findUnique({ where: { idempotencyKey } }));
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
  tenantId: string;
  parentRunId: string;
  fanOutIndex: number;
  subgraphKeys: string[];
  seedNodeKey: string;
  seedOutput: unknown;
  idempotencyKey: string;
}): Promise<{ run: Run; created: boolean }> {
  const existing = await withTenant(params.tenantId, (tx) =>
    tx.run.findUnique({ where: { idempotencyKey: params.idempotencyKey } }),
  );
  if (existing) return { run: existing, created: false };

  try {
    const run = await withTenant(params.tenantId, async (tx) => {
      const child = await tx.run.create({
        data: {
          workflowVersionId: params.workflowVersionId,
          tenantId: params.tenantId,
          triggeredBy: 'fanout',
          idempotencyKey: params.idempotencyKey,
          parentRunId: params.parentRunId,
          fanOutIndex: params.fanOutIndex,
        },
      });
      await tx.nodeRun.create({
        data: {
          runId: child.id,
          tenantId: params.tenantId,
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
            tenantId: params.tenantId,
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
    // A concurrent spawn of the same index lost the unique-key race — return
    // theirs. Deliberately a FRESH withTenant call (a new transaction), not a
    // continuation of the failed one above — Postgres aborts the rest of a
    // transaction after any statement inside it fails, so re-querying on the
    // same `tx` here would itself fail with "current transaction is aborted".
    const raced = await withTenant(params.tenantId, (tx) =>
      tx.run.findUnique({ where: { idempotencyKey: params.idempotencyKey } }),
    );
    if (raced) return { run: raced, created: false };
    throw err;
  }
}

/** Count of a parent's children that are not in a terminal RunStatus. Zero ⇒ join. */
export async function countNonTerminalChildren(parentRunId: string, tenantId: string): Promise<number> {
  return withTenant(tenantId, (tx) =>
    tx.run.count({
      where: { parentRunId, status: { notIn: ['SUCCEEDED', 'FAILED', 'CANCELLED'] } },
    }),
  );
}

/** Minimal parent-tree fields for a run, or null if the run doesn't exist. */
export async function getRunTreeInfo(
  runId: string,
  tenantId: string,
): Promise<{ parentRunId: string | null; fanOutIndex: number | null; idempotencyKey: string | null; status: string } | null> {
  return withTenant(tenantId, (tx) =>
    tx.run.findUnique({
      where: { id: runId },
      select: { parentRunId: true, fanOutIndex: true, idempotencyKey: true, status: true },
    }),
  );
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
  tenantId: string,
): Promise<Array<{ fanOutIndex: number; status: string; element: unknown }>> {
  return withTenant(tenantId, async (tx) => {
    const children = await tx.run.findMany({
      where: { parentRunId },
      orderBy: { fanOutIndex: 'asc' },
      select: { id: true, fanOutIndex: true, status: true },
    });
    if (children.length === 0) return [];

    const nodeRuns = await tx.nodeRun.findMany({
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
export async function getChildRunSummary(parentRunId: string, tenantId: string): Promise<ChildRunSummary> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.run.groupBy({
      by: ['status'],
      where: { parentRunId },
      _count: { _all: true },
    }),
  );
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
  tenantId: string,
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
  const rows = await withTenant(tenantId, (tx) =>
    tx.run.findMany({
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
    }),
  );

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
  tenantId: string,
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
  const result = await withTenant(tenantId, (tx) =>
    tx.nodeRun.updateMany({
      where: { id: nodeRunId, status: from },
      data: { status: to, ...extra },
    }),
  );

  return result.count > 0;
}

/**
 * Convenience overload for finding a NodeRun by (runId, nodeKey) — the logical key.
 */
export async function findNodeRun(
  runId: string,
  nodeKey: string,
  tenantId: string,
): Promise<NodeRun | null> {
  return withTenant(tenantId, (tx) =>
    tx.nodeRun.findUnique({
      where: { runId_nodeKey: { runId, nodeKey } },
    }),
  );
}

/**
 * Stamps `error` on a NodeRun without changing its status (roadmap B5). The
 * worker calls this on every failed attempt so the taxonomy-rich error is on
 * the row before it throws — `onNodeFailed` then preserves it rather than
 * overwriting with the bare BullMQ `failedReason` string.
 */
export async function setNodeRunError(
  nodeRunId: string,
  tenantId: string,
  error: Prisma.InputJsonValue,
): Promise<void> {
  await withTenant(tenantId, (tx) => tx.nodeRun.update({ where: { id: nodeRunId }, data: { error } }));
}

/**
 * Returns all NodeRuns for a run, keyed by nodeKey for O(1) access in the orchestrator.
 */
export async function getNodeRunMap(
  runId: string,
  tenantId: string,
): Promise<Map<string, NodeRun>> {
  const rows = await withTenant(tenantId, (tx) => tx.nodeRun.findMany({ where: { runId } }));
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
  tenantId: string,
  extra?: {
    startedAt?: Date | null;
    finishedAt?: Date | null;
  },
): Promise<boolean> {
  const result = await withTenant(tenantId, (tx) =>
    tx.run.updateMany({
      where: { id: runId, status: from },
      data: { status: to, ...extra },
    }),
  );

  return result.count > 0;
}

/**
 * Checks whether all NodeRuns for a run are in a terminal state.
 * Used by the orchestrator to decide when to mark the Run SUCCEEDED.
 */
export async function allNodeRunsTerminal(runId: string, tenantId: string): Promise<boolean> {
  const pending = await withTenant(tenantId, (tx) =>
    tx.nodeRun.count({
      where: {
        runId,
        status: { notIn: ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'] },
      },
    }),
  );
  return pending === 0;
}

// ─── RunEvent (append-only audit log) ───────────────────────────────────────

/**
 * Appends a structured event to the audit log.
 * Also used as the SSE replay source (via cursor on the BigInt id).
 */
export async function appendRunEvent(
  runId: string,
  tenantId: string,
  type: string,
  payload: Prisma.InputJsonValue,
  nodeKey?: string,
): Promise<RunEvent> {
  return withTenant(tenantId, (tx) =>
    tx.runEvent.create({
      data: { runId, tenantId, type, payload, nodeKey },
    }),
  );
}

/**
 * Fetches events for SSE replay. `afterId` is the Last-Event-ID cursor.
 * Returns events in ascending order so the client replays them in order.
 */
export async function getRunEvents(
  runId: string,
  tenantId: string,
  afterId?: bigint,
): Promise<RunEvent[]> {
  return withTenant(tenantId, (tx) =>
    tx.runEvent.findMany({
      where: {
        runId,
        ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: 'asc' },
    }),
  );
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
  const rows = await withAdminContext((tx) => tx.nodeRun.groupBy({ by: ['status'], _count: { _all: true } }));
  const result: Record<string, number> = {};
  for (const row of rows) result[row.status] = row._count._all;
  return result;
}

/** Same idea as {@link countNodeRunsByStatus}, one row per Run. */
export async function countRunsByStatus(): Promise<Record<string, number>> {
  const rows = await withAdminContext((tx) => tx.run.groupBy({ by: ['status'], _count: { _all: true } }));
  const result: Record<string, number> = {};
  for (const row of rows) result[row.status] = row._count._all;
  return result;
}

// ─── Schedules & Triggers (roadmap B2) ──────────────────────────────────────

export type { Schedule, Trigger } from './generated/client';

/**
 * The id of a workflow's newest version, or null if it has none / is
 * soft-deleted / belongs to another tenant. `tenantId` is required — the
 * schedule/trigger fire paths that don't have one in hand yet resolve it
 * first via {@link getWorkflowTenantId}.
 */
export async function getLatestVersionId(
  workflowId: string,
  tenantId: string,
): Promise<string | null> {
  const wf = await withTenant(tenantId, (tx) =>
    tx.workflow.findFirst({
      where: { id: workflowId, tenantId, deletedAt: null },
      select: {
        versions: { orderBy: { version: 'desc' }, take: 1, select: { id: true } },
      },
    }),
  );
  return wf?.versions[0]?.id ?? null;
}

/**
 * Which tenant owns a workflow, or null if it doesn't exist / is
 * soft-deleted. Admin-context by construction: this is the one query that
 * has to run BEFORE any tenant context is known, for callers that only have
 * a bare `workflowId` — the scheduler tick and webhook delivery paths, which
 * resolve a `Schedule`/`Trigger` row (neither RLS-protected) by id/token
 * with no authenticated request behind them at all.
 */
export async function getWorkflowTenantId(workflowId: string): Promise<string | null> {
  const wf = await withAdminContext((tx) =>
    tx.workflow.findFirst({ where: { id: workflowId, deletedAt: null }, select: { tenantId: true } }),
  );
  return wf?.tenantId ?? null;
}

/** True iff the workflow exists, is not soft-deleted, and belongs to the tenant. */
export async function workflowBelongsToTenant(workflowId: string, tenantId: string): Promise<boolean> {
  const wf = await withTenant(tenantId, (tx) =>
    tx.workflow.findFirst({
      where: { id: workflowId, tenantId, deletedAt: null },
      select: { id: true },
    }),
  );
  return wf !== null;
}

/**
 * Which tenant owns a run, or null if it doesn't exist. Admin-context, same
 * rationale as {@link getWorkflowTenantId}: BullMQ's `QueueEvents` `completed`/
 * `failed` handlers (`apps/api/src/worker-events.ts`) only carry a bare
 * `jobId` (parsed into `runId`/`nodeKey`) — no tenant context travels with
 * them — so `onNodeSucceeded`/`onNodeFailed` resolve it here before doing
 * anything else.
 */
export async function resolveTenantForRun(runId: string): Promise<string | null> {
  const run = await withAdminContext((tx) => tx.run.findUnique({ where: { id: runId }, select: { tenantId: true } }));
  return run?.tenantId ?? null;
}

/**
 * Roadmap C2.3 — the max number of NodeRuns this tenant may have QUEUED or
 * RUNNING across the cluster at once (enforced by a Redis semaphore in
 * `dispatchNode`, see `packages/queue/src/tenant-quota.ts`). `Tenant` is not
 * RLS-protected — reading a tenant's own row by its own id needs no context —
 * so this is a plain, unscoped lookup, same as `findActiveApiKeyByHash`.
 */
export async function getTenantConcurrencyLimit(tenantId: string): Promise<number> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { concurrencyLimit: true } });
  return tenant?.concurrencyLimit ?? 20;
}

/**
 * True iff the run exists and belongs to the tenant. Now backed by RLS
 * itself (roadmap C2.1) — `withTenant` alone would hide a wrong-tenant run,
 * making the explicit `tenantId` filter redundant, but keeping it is exactly
 * the "defense in depth" this function existed for since A3: if RLS were
 * ever misconfigured, this check still catches it.
 */
export async function runBelongsToTenant(runId: string, tenantId: string): Promise<boolean> {
  const run = await withTenant(tenantId, (tx) =>
    tx.run.findFirst({
      where: { id: runId, tenantId },
      select: { id: true },
    }),
  );
  return run !== null;
}

// ─── API Keys (roadmap A3) ───────────────────────────────────────────────────

export type { ApiKey } from './generated/client';

/** Looks up an active (non-revoked) key by its SHA-256 hash. Never by the raw key. */
export async function findActiveApiKeyByHash(hash: string) {
  return prisma.apiKey.findFirst({
    where: { hash, revokedAt: null },
    select: { id: true, tenantId: true, name: true },
  });
}

/** Creates a key row for a pre-computed hash. The raw key never touches the DB — see `apps/api/scripts/seed.ts`. */
export async function createApiKey(tenantId: string, name: string, hash: string) {
  return prisma.apiKey.create({ data: { tenantId, name, hash } });
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
