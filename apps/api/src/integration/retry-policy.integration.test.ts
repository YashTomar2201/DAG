/**
 * B5 — Integration: per-node retry policy (Testcontainers).
 *
 * `NodeDef.retryPolicy` was dead schema — every node used the global
 * `attempts: 3`. Now `dispatchNode` threads it into the BullMQ job options.
 *
 *   - `attempts: 1` on a retryable failure → runs once, fails.
 *   - `attempts: 4` on a retryable failure → runs 4 times, fails, error
 *     tagged `retryable` with attempt 4.
 *   - an UNRECOVERABLE failure ignores `attempts` → runs once regardless.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { seedWorkflowVersion, cleanupWorkflow, waitUntil } from './fixtures';
import type { Graph } from '@dag/contracts';

/** One node that fails; `fail.py` exits 1 with a plain (retryable) error. */
function failGraph(retryPolicy: Record<string, number>): Graph {
  return {
    nodes: [
      {
        key: 'boom',
        type: 'pandas.preprocess',
        label: 'Boom',
        position: { x: 0, y: 0 },
        config: { scriptPath: 'fail.py' },
        retryPolicy,
      },
    ],
    edges: [],
  } as unknown as Graph;
}

/** One node whose failure is UNRECOVERABLE (the minAccuracy gate throws it). */
function unrecoverableGraph(retryPolicy: Record<string, number>): Graph {
  return {
    nodes: [
      {
        key: 'gate',
        type: 'model.evaluate',
        label: 'Gate',
        position: { x: 0, y: 0 },
        config: { scriptPath: 'evaluate.py', minAccuracy: 1 }, // 0.923 < 1 → always fails
        retryPolicy,
      },
    ],
    edges: [],
  } as unknown as Graph;
}

describe('B5 — retry policy', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let stopQueueEvents: () => void;
  let tenantId: string;
  let workflowId: string;
  let nextVersion = 1;

  const seed = async (g: Graph) => {
    if (nextVersion === 1) {
      const s = await seedWorkflowVersion(ctx.db.prisma, g, 'b5');
      tenantId = s.tenantId;
      workflowId = s.workflowId;
      nextVersion = 2;
      return s.versionId;
    }
    const v = await ctx.db.prisma.workflowVersion.create({
      data: { workflowId, version: nextVersion++, graph: g as unknown as object, topoOrder: {} as unknown as object },
    });
    return v.id;
  };

  const runToFailed = async (versionId: string, nodeKey: string) => {
    const run = await ctx.orchestrator.startRun(versionId);
    await waitUntil(
      async () => {
        const r = await ctx.db.prisma.run.findUnique({ where: { id: run.id }, select: { status: true } });
        return r?.status === 'FAILED' || r?.status === 'SUCCEEDED';
      },
      { timeoutMs: 60_000 },
    );
    const nr = await ctx.db.prisma.nodeRun.findUnique({
      where: { runId_nodeKey: { runId: run.id, nodeKey } },
    });
    const job = await ctx.queue.cpuQueue.getJob(ctx.queue.createJobId(run.id, nodeKey, nr!.attempt));
    return { runId: run.id, nr, attemptsMade: job?.attemptsMade ?? null };
  };

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();
    stopQueueEvents = ctx.workerEvents.startQueueEventListeners();
  }, 60_000);

  afterAll(async () => {
    stopQueueEvents?.();
    if (workflowId) {
      await ctx.db.prisma.runEvent.deleteMany({
        where: { run: { workflowVersion: { workflowId } } },
      });
      await ctx.db.prisma.nodeRun.deleteMany({
        where: { run: { workflowVersion: { workflowId } } },
      });
      await ctx.db.prisma.run.deleteMany({ where: { workflowVersion: { workflowId } } });
      await cleanupWorkflow(ctx.db.prisma, tenantId, workflowId);
    }
    await teardownTestEnv(ctx);
  });

  it('attempts: 1 → the node runs once and fails', async () => {
    const vid = await seed(failGraph({ attempts: 1, baseDelay: 50, cap: 200 }));
    const { runId, nr, attemptsMade } = await runToFailed(vid, 'boom');

    expect(nr?.status).toBe('FAILED');
    expect(attemptsMade).toBe(1);
    expect(nr?.error).toMatchObject({ taxonomy: 'retryable', attempt: 1, maxAttempts: 1 });

    const failEvt = await ctx.db.prisma.runEvent.findFirst({
      where: { runId, nodeKey: 'boom', type: 'NODE_FAILED' },
    });
    expect((failEvt?.payload as { error?: { taxonomy?: string } }).error?.taxonomy).toBe('retryable');
  });

  it('attempts: 4 → the node runs 4 times, then fails as retryable', async () => {
    const vid = await seed(failGraph({ attempts: 4, baseDelay: 50, cap: 200 }));
    const { nr, attemptsMade } = await runToFailed(vid, 'boom');

    expect(nr?.status).toBe('FAILED');
    expect(attemptsMade).toBe(4);
    expect(nr?.error).toMatchObject({ taxonomy: 'retryable', attempt: 4, maxAttempts: 4 });
  });

  it('an unrecoverable failure ignores attempts (runs once)', async () => {
    const vid = await seed(unrecoverableGraph({ attempts: 5, baseDelay: 50, cap: 200 }));
    const run = await ctx.orchestrator.startRun(vid);
    await waitUntil(
      async () => {
        const r = await ctx.db.prisma.run.findUnique({ where: { id: run.id }, select: { status: true } });
        return r?.status === 'FAILED';
      },
      { timeoutMs: 60_000 },
    );
    const nr = await ctx.db.prisma.nodeRun.findUnique({
      where: { runId_nodeKey: { runId: run.id, nodeKey: 'gate' } },
    });
    const job = await ctx.queue.cpuQueue.getJob(ctx.queue.createJobId(run.id, 'gate', nr!.attempt));

    expect(nr?.status).toBe('FAILED');
    expect(job?.attemptsMade).toBe(1); // no retries despite attempts: 5
    expect(nr?.error).toMatchObject({ taxonomy: 'unrecoverable' });
  });
});
