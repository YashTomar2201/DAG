import { prisma, getRunEvents } from '@dag/db';
import { NotFoundError } from '../errors';
import { ioQueue, cpuQueue, gpuQueue, createJobId } from '@dag/queue';
import { dispatchNode } from './orchestrator.service';
import { logger } from '../logger';

// ─── Run reads ────────────────────────────────────────────────────────────────

/**
 * Returns a full Run record with all its NodeRuns and timing info.
 * Used by `GET /runs/:id`.
 */
export async function getRunService(runId: string) {
  const run = await prisma.run.findUnique({
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
  });

  if (!run) throw new NotFoundError('Run', runId);

  return run;
}

/**
 * Returns persisted RunEvents for SSE replay.
 * `afterId` is the `Last-Event-ID` cursor from a reconnecting SSE client.
 */
export async function getRunEventsService(runId: string, afterId?: string) {
  // Verify the run exists
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { id: true },
  });
  if (!run) throw new NotFoundError('Run', runId);

  const cursorId = afterId ? BigInt(afterId) : undefined;
  return getRunEvents(runId, cursorId);
}

// ─── Run cancellation (Phase 6 will add orchestration logic here) ─────────────

/**
 * Marks a run as CANCELLED. Full orchestration (removing queue jobs, transitioning
 * NodeRuns) is implemented in Phase 6 when the orchestrator is wired up.
 * This stub sets the DB status so the API surface is complete for Phase 4.
 */
export async function cancelRunService(runId: string) {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { id: true, status: true },
  });
  if (!run) throw new NotFoundError('Run', runId);

  // Only cancel a non-terminal run
  const terminalStatuses = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
  if ((terminalStatuses as readonly string[]).includes(run.status)) {
    return { alreadyTerminal: true, status: run.status };
  }

  await prisma.run.update({
    where: { id: runId },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });

  // Phase 6: Remove pending jobs from BullMQ
  const activeNodes = await prisma.nodeRun.findMany({
    where: {
      runId,
      status: { in: ['PENDING', 'QUEUED'] },
    },
    select: { nodeKey: true, attempt: true },
  });

  for (const node of activeNodes) {
    const jobId = createJobId(runId, node.nodeKey, node.attempt);
    // Best effort removal across all queues since we don't have the node type handy
    await Promise.allSettled([
      ioQueue.remove(jobId),
      cpuQueue.remove(jobId),
      gpuQueue.remove(jobId),
    ]);
  }

  // Cancel all non-terminal NodeRuns
  await prisma.nodeRun.updateMany({
    where: {
      runId,
      status: { notIn: ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'] },
    },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });

  return { alreadyTerminal: false, status: 'CANCELLED' };
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
export async function retryFailedNodesService(runId: string) {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      nodeRuns: { select: { id: true, nodeKey: true, status: true, attempt: true } },
      workflowVersion: true,
    },
  });
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
    await prisma.nodeRun.update({
      where: { id: nr.id },
      data: {
        status: 'PENDING',
        attempt: nr.attempt + 1,
        error: undefined,
        startedAt: null,
        finishedAt: null,
      },
    });
  }

  // Reset skipped descendants to PENDING so they can run after retry
  for (const nr of skippedNodes) {
    await prisma.nodeRun.update({
      where: { id: nr.id },
      data: {
        status: 'PENDING',
        error: undefined,
        startedAt: null,
        finishedAt: null,
      },
    });
  }

  // Transition run back to RUNNING
  await prisma.run.update({
    where: { id: runId },
    data: { status: 'RUNNING', finishedAt: null },
  });

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
      await dispatchNode(runId, nr.nodeKey);
    } catch (err) {
      logger.error({ runId, nodeKey: nr.nodeKey, err }, 'retry-failed: dispatch failed');
    }
  }

  return {
    retried: failedNodes.length,
    resetSkipped: skippedNodes.length,
    message: `${failedNodes.length} node(s) queued for retry`,
  };
}
