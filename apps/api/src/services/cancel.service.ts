/**
 * Run cancellation primitives (roadmap B3.4).
 *
 * Kept in their own module so both `run.service` (the `POST /runs/:id/cancel`
 * entry point) and `orchestrator.service` (fan-out fail-fast, which cancels
 * still-running sibling child runs) can use them without an import cycle — this
 * file imports only `@dag/db` and `@dag/queue`.
 */

import { withTenant } from '@dag/db';
import { ioQueue, cpuQueue, gpuQueue, createJobId, markRunCancelled } from '@dag/queue';
import { logger } from '../logger';

const NON_TERMINAL_RUN = ['PENDING', 'RUNNING'] as const;

/**
 * Cancels a single run: mark it CANCELLED, best-effort-remove its still-queued
 * BullMQ jobs, and CANCELLED every non-terminal NodeRun. No-op (returns
 * `alreadyTerminal`) if the run is already SUCCEEDED / FAILED / CANCELLED.
 */
export async function cancelOneRun(
  runId: string,
  tenantId: string,
): Promise<{ alreadyTerminal: boolean; status: string }> {
  const run = await withTenant(tenantId, (tx) => tx.run.findUnique({ where: { id: runId }, select: { status: true } }));
  if (!run) return { alreadyTerminal: true, status: 'MISSING' };
  if (!(NON_TERMINAL_RUN as readonly string[]).includes(run.status)) {
    return { alreadyTerminal: true, status: run.status };
  }

  // Set the hard-cancel flag FIRST (roadmap B4): a worker already running a
  // node for this run polls it and aborts its Python child within ~15 s.
  await markRunCancelled(runId);

  await withTenant(tenantId, (tx) =>
    tx.run.update({
      where: { id: runId },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    }),
  );

  const activeNodes = await withTenant(tenantId, (tx) =>
    tx.nodeRun.findMany({
      where: { runId, status: { in: ['PENDING', 'QUEUED'] } },
      select: { nodeKey: true, attempt: true },
    }),
  );
  for (const node of activeNodes) {
    const jobId = createJobId(runId, node.nodeKey, node.attempt);
    // We don't have the node type handy — remove from every queue, best effort.
    await Promise.allSettled([ioQueue.remove(jobId), cpuQueue.remove(jobId), gpuQueue.remove(jobId)]);
  }

  await withTenant(tenantId, (tx) =>
    tx.nodeRun.updateMany({
      where: { runId, status: { notIn: ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'] } },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    }),
  );

  return { alreadyTerminal: false, status: 'CANCELLED' };
}

/** Cancels every non-terminal descendant run of `parentRunId` (depth-first). */
export async function cancelChildRunsOf(parentRunId: string, tenantId: string): Promise<number> {
  const children = await withTenant(tenantId, (tx) =>
    tx.run.findMany({
      where: { parentRunId, status: { in: [...NON_TERMINAL_RUN] } },
      select: { id: true },
    }),
  );
  let cancelled = 0;
  for (const child of children) {
    cancelled += await cancelChildRunsOf(child.id, tenantId); // nested fan-out (future) first
    const r = await cancelOneRun(child.id, tenantId);
    if (!r.alreadyTerminal) cancelled += 1;
  }
  if (cancelled > 0) logger.info({ parentRunId, cancelled }, 'Cancelled fan-out child runs');
  return cancelled;
}

/** Cancels a run and its whole child-run subtree. Backs `POST /runs/:id/cancel`. */
export async function cancelRunTree(
  runId: string,
  tenantId: string,
): Promise<{ alreadyTerminal: boolean; status: string; childrenCancelled: number }> {
  const childrenCancelled = await cancelChildRunsOf(runId, tenantId);
  const self = await cancelOneRun(runId, tenantId);
  return { ...self, childrenCancelled };
}
