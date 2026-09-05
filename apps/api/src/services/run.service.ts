import { withTenant, getRunEvents, getChildRunSummary, listChildRuns, runBelongsToTenant } from '@dag/db';
import { NotFoundError } from '../errors';
import { dispatchNode, retryFanOutChildren } from './orchestrator.service';
import { cancelRunTree } from './cancel.service';
import { logger } from '../logger';

// ─── Run reads ────────────────────────────────────────────────────────────────

/**
 * Returns a full Run record with all its NodeRuns and timing info.
 * Used by `GET /runs/:id`.
 *
 * `children` (roadmap B3) is a per-status count of the run's fan-out children,
 * computed with a `groupBy` — never by loading the child rows. It is an
 * all-zero summary for an ordinary run, so existing consumers see no change in
 * shape beyond the new key.
 *
 * Roadmap A3: `tenantId` must belong to the run's own workflow, or this 404s
 * exactly like a run that doesn't exist — a leaked/guessed run id from
 * another tenant must never be distinguishable from a wrong id.
 */
export async function getRunService(runId: string, tenantId: string) {
  if (!(await runBelongsToTenant(runId, tenantId))) throw new NotFoundError('Run', runId);

  const run = await withTenant(tenantId, (tx) =>
    tx.run.findUnique({
      where: { id: runId },
      include: {
        nodeRuns: {
          orderBy: { nodeKey: 'asc' },
          select: {
            id: true,
            nodeKey: true,
            status: true,
            attempt: true,
            startedAt: true,
            finishedAt: true,
            workerId: true,
            output: true,
            error: true,
            // Do NOT select input here — it can be large (resolved template)
          },
        },
      },
    }),
  );

  if (!run) throw new NotFoundError('Run', runId);

  const children = await getChildRunSummary(runId, tenantId);

  return { ...run, children };
}

const CHILDREN_PAGE_DEFAULT = 50;
const CHILDREN_PAGE_MAX = 200;

/**
 * Paginated list of a run's direct fan-out children, ordered by `fanOutIndex`.
 * Backs `GET /runs/:id/children` (the B3.5 drill-in view).
 */
export async function listRunChildrenService(
  runId: string,
  tenantId: string,
  opts: { limit?: number; cursor?: string } = {},
) {
  if (!(await runBelongsToTenant(runId, tenantId))) throw new NotFoundError('Run', runId);

  const limit = Math.min(Math.max(opts.limit ?? CHILDREN_PAGE_DEFAULT, 1), CHILDREN_PAGE_MAX);
  return listChildRuns(runId, tenantId, { limit, cursor: opts.cursor });
}

/**
 * Returns persisted RunEvents for SSE replay.
 * `afterId` is the `Last-Event-ID` cursor from a reconnecting SSE client.
 */
export async function getRunEventsService(runId: string, tenantId: string, afterId?: string) {
  if (!(await runBelongsToTenant(runId, tenantId))) throw new NotFoundError('Run', runId);

  const cursorId = afterId ? BigInt(afterId) : undefined;
  return getRunEvents(runId, tenantId, cursorId);
}

// ─── Run cancellation ────────────────────────────────────────────────────────

/**
 * Cancels a run and its entire fan-out child-run subtree (roadmap B3.4): each
 * run is marked CANCELLED, its still-queued BullMQ jobs are removed, and its
 * non-terminal NodeRuns are CANCELLED. See `cancel.service.ts`.
 */
export async function cancelRunService(runId: string, tenantId: string) {
  if (!(await runBelongsToTenant(runId, tenantId))) throw new NotFoundError('Run', runId);

  const result = await cancelRunTree(runId, tenantId);
  logger.info({ runId, ...result }, 'Run cancel');
  return result;
}

// ─── Retry failed nodes (Phase 9) ────────────────────────────────────────────

/**
 * Re-dispatches all FAILED nodes in a run (and resets their SKIPPED descendants
 * to PENDING so the orchestrator will pick them up after the retry succeeds).
 *
 * This implements `POST /runs/:id/retry-failed`.
 *
 * Why only FAILED+SKIPPED — not SUCCEEDED?
 *   Re-running a SUCCEEDED node wastes work and can create duplicate artifacts.
 *   The executor idempotency check would short-circuit it safely, but the
 *   intent is cleaner if we only touch truly failed portions of the graph.
 *
 * The run transitions back to RUNNING after this call.
 */
export async function retryFailedNodesService(runId: string, tenantId: string) {
  if (!(await runBelongsToTenant(runId, tenantId))) throw new NotFoundError('Run', runId);

  const run = await withTenant(tenantId, (tx) =>
    tx.run.findUnique({
      where: { id: runId },
      include: {
        nodeRuns: { select: { id: true, nodeKey: true, status: true, attempt: true } },
        workflowVersion: true,
      },
    }),
  );
  if (!run) throw new NotFoundError('Run', runId);

  // Only a FAILED run can be retried
  if (run.status !== 'FAILED') {
    return { retried: 0, message: `Run is ${run.status} — only FAILED runs can be retried` };
  }

  // Reset FAILED nodes to PENDING (incrementing attempt counter)
  const failedNodes = run.nodeRuns.filter((nr) => nr.status === 'FAILED');
  const skippedNodes = run.nodeRuns.filter((nr) => nr.status === 'SKIPPED');

  // Reset failed nodes to PENDING with incremented attempt
  for (const nr of failedNodes) {
    await withTenant(tenantId, (tx) =>
      tx.nodeRun.update({
        where: { id: nr.id },
        data: {
          status: 'PENDING',
          attempt: nr.attempt + 1,
          error: undefined,
          startedAt: null,
          finishedAt: null,
        },
      }),
    );
  }

  // Reset skipped descendants to PENDING so they can run after retry
  for (const nr of skippedNodes) {
    await withTenant(tenantId, (tx) =>
      tx.nodeRun.update({
        where: { id: nr.id },
        data: {
          status: 'PENDING',
          error: undefined,
          startedAt: null,
          finishedAt: null,
        },
      }),
    );
  }

  // Transition run back to RUNNING
  await withTenant(tenantId, (tx) =>
    tx.run.update({
      where: { id: runId },
      data: { status: 'RUNNING', finishedAt: null },
    }),
  );

  // ── Dispatch the retried nodes ──────────────────────────────────────────
  // Resetting a FAILED row to PENDING does not, by itself, get the node back
  // onto a queue: dispatch normally happens either from `startRun`'s initial
  // ready-set scan or from `onNodeSucceeded`'s Lua in-degree decrement when a
  // *parent* completes. Neither of those fires here — the parent already
  // succeeded (a node can only reach FAILED after it actually ran, which
  // means its own dependencies were already satisfied), so nothing will ever
  // "unlock" it again unless we dispatch it ourselves.
  //
  // This is safe without touching Redis in-degree state: `onNodeFailed`
  // never decremented the SKIPPED descendants' in-degree counters when the
  // original failure happened (it marks them SKIPPED directly via BFS — see
  // orchestrator.service.ts), so those counters are still sitting at their
  // original "waiting on this branch" value. When the re-dispatched node
  // succeeds, `onNodeSucceeded` will decrement them exactly once, through
  // the normal atomic path, and dispatch them normally.
  for (const nr of failedNodes) {
    try {
      await dispatchNode(runId, nr.nodeKey, tenantId);
    } catch (err) {
      logger.error({ runId, nodeKey: nr.nodeKey, err }, 'retry-failed: dispatch failed');
    }
  }

  // ── Fan-out (B3.4) ──────────────────────────────────────────────────────
  // A fan-out that failed fast has no FAILED nodes in the parent run — the
  // failure is in child runs. Re-spawn ONLY the failed/cancelled children of
  // each flow.map node and release its join claim so the join can re-fire.
  let respawnedChildren = 0;
  try {
    respawnedChildren = await retryFanOutChildren(runId, tenantId, run.workflowVersionId);
  } catch (err) {
    logger.error({ runId, err }, 'retry-failed: fan-out child re-spawn failed');
  }

  return {
    retried: failedNodes.length,
    resetSkipped: skippedNodes.length,
    respawnedChildren,
    message:
      `${failedNodes.length} node(s) queued for retry` +
      (respawnedChildren > 0 ? `; ${respawnedChildren} fan-out child run(s) re-spawned` : ''),
  };
}
