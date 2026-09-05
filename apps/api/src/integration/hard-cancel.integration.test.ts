/**
 * B4 — Integration: hard cancellation stops in-flight work (Testcontainers).
 *
 * `POST /runs/:id/cancel` already drains queued jobs; B4 makes it kill a job a
 * worker has ALREADY picked up. This test starts the reference pipeline with a
 * deliberately long `train`, waits until `train` is genuinely RUNNING (a real
 * Python process on a worker), cancels, and asserts:
 *   - the `train` gpu job settles within ~15 s (not after the full ~80 s run)
 *   - the `train` Python loop was killed mid-way (max logged iter << epochs)
 *   - the NodeRun lands on CANCELLED, not FAILED
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { hermeticPipelineGraph, seedWorkflowVersion, cleanupWorkflow, waitUntil } from './fixtures';
import type { Graph } from '@dag/contracts';

const EPOCHS = 2000; // ~80 s of simulated training on a warm host — long enough to cancel mid-flight

describe('B4 — hard cancellation', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let stopQueueEvents: () => void;
  let tenantId: string;
  let workflowId: string;
  let versionId: string;

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();
    stopQueueEvents = ctx.workerEvents.startQueueEventListeners();

    const graph = hermeticPipelineGraph();
    (graph.nodes.find((n) => n.key === 'train')!.config as Record<string, unknown>)['epochs'] = EPOCHS;

    const seeded = await seedWorkflowVersion(ctx.db.prisma, graph as Graph, 'b4');
    tenantId = seeded.tenantId;
    workflowId = seeded.workflowId;
    versionId = seeded.versionId;
  }, 60_000);

  afterAll(async () => {
    stopQueueEvents?.();
    await cleanupWorkflow(ctx.db.prisma, tenantId, workflowId);
    await teardownTestEnv(ctx);
  });

  it('kills the running Python process and lands the NodeRun on CANCELLED', async () => {
    const run = await ctx.orchestrator.startRun(versionId);

    // Wait until `train` is really executing on a worker.
    await waitUntil(
      async () => {
        const nr = await ctx.db.prisma.nodeRun.findUnique({
          where: { runId_nodeKey: { runId: run.id, nodeKey: 'train' } },
        });
        return nr?.status === 'RUNNING' && nr.workerId != null;
      },
      { timeoutMs: 60_000 },
    );

    const trainNr = await ctx.db.prisma.nodeRun.findUnique({
      where: { runId_nodeKey: { runId: run.id, nodeKey: 'train' } },
      select: { attempt: true },
    });
    const jobId = ctx.queue.createJobId(run.id, 'train', trainNr!.attempt);

    const cancelledAt = Date.now();
    const result = await ctx.runService.cancelRunService(run.id, tenantId);
    expect(result.status).toBe('CANCELLED');
    expect(await ctx.queue.isRunCancelled(run.id)).toBe(true);

    // The gpu job must stop far sooner than the natural ~80 s run.
    await waitUntil(
      async () => {
        const job = await ctx.queue.gpuQueue.getJob(jobId);
        if (!job) return true;
        const state = await job.getState();
        return state === 'completed' || state === 'failed';
      },
      { timeoutMs: 20_000, intervalMs: 500 },
    );
    expect(Date.now() - cancelledAt).toBeLessThan(20_000);

    // Give the worker's CANCELLED transition a beat to land.
    await new Promise((r) => setTimeout(r, 1500));

    const finalTrain = await ctx.db.prisma.nodeRun.findUnique({
      where: { runId_nodeKey: { runId: run.id, nodeKey: 'train' } },
    });
    expect(finalTrain?.status).toBe('CANCELLED');
    expect(finalTrain?.status).not.toBe('FAILED');

    const finalRun = await ctx.db.prisma.run.findUnique({ where: { id: run.id } });
    expect(finalRun?.status).toBe('CANCELLED');

    // The Python loop was interrupted — the highest logged iteration is well
    // below EPOCHS (it would reach EPOCHS only if the process ran to completion).
    const logs = await ctx.db.prisma.runEvent.findMany({
      where: { runId: run.id, nodeKey: 'train', type: 'NODE_LOG' },
      select: { payload: true },
    });
    const iters = logs
      .map((e) => /iter (\d+)\//.exec(String((e.payload as { line?: unknown }).line ?? '')))
      .filter((m): m is RegExpExecArray => m != null)
      .map((m) => Number(m[1]));
    if (iters.length > 0) {
      expect(Math.max(...iters)).toBeLessThan(EPOCHS);
    }

    // Every NodeRun is terminal — cancel never leaves a row stuck.
    const all = await ctx.db.prisma.nodeRun.findMany({ where: { runId: run.id }, select: { status: true } });
    for (const nr of all) {
      expect(['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED']).toContain(nr.status);
    }
  }, 120_000);
});
