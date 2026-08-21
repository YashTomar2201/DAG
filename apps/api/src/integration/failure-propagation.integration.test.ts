/**
 * Phase 12 — Integration: failure propagation to SKIPPED (Testcontainers).
 *
 * Forces a genuine, deterministic node failure — `evaluate` is configured
 * with `minAccuracy: 0.99`. `apps/worker/python/evaluate.py` always reports
 * a fixed accuracy of 0.923, so `modelEvaluate()` in
 * apps/worker/src/executors.ts throws a real `UnrecoverableError` (0.923 <
 * 0.99). This exercises the real error-taxonomy → BullMQ "failed" →
 * onNodeFailed → BFS SKIPPED path end to end, not a mocked failure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { hermeticPipelineGraph, seedWorkflowVersion, cleanupWorkflow, waitUntil } from './fixtures';
import type { Graph } from '@dag/contracts';

describe('Phase 12 — failure propagates to SKIPPED descendants', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let stopQueueEvents: () => void;
  let tenantId: string;
  let workflowId: string;
  let versionId: string;

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();

    // Execution happens on the shared worker processes spawned once in
    // global-setup.ts — see that file for why.
    stopQueueEvents = ctx.workerEvents.startQueueEventListeners();

    const graph = hermeticPipelineGraph();
    // Force `evaluate` to fail: evaluate.py always reports accuracy 0.923;
    // set the threshold above that so the real executor's minAccuracy gate rejects it.
    const evaluateNode = graph.nodes.find((n) => n.key === 'evaluate')!;
    (evaluateNode.config as Record<string, unknown>)['minAccuracy'] = 0.99;

    const seeded = await seedWorkflowVersion(ctx.db.prisma, graph as Graph, 'failure-propagation');
    tenantId = seeded.tenantId;
    workflowId = seeded.workflowId;
    versionId = seeded.versionId;
  }, 60_000);

  afterAll(async () => {
    stopQueueEvents?.();
    await cleanupWorkflow(ctx.db.prisma, tenantId, workflowId);
    await teardownTestEnv(ctx);
  });

  it('marks evaluate FAILED, deploy SKIPPED, extract/preprocess/train SUCCEEDED, run FAILED', async () => {
    const run = await ctx.orchestrator.startRun(versionId);

    await waitUntil(async () => {
      const r = await ctx.db.prisma.run.findUnique({ where: { id: run.id } });
      return r?.status === 'FAILED' || r?.status === 'SUCCEEDED';
    });

    const finalRun = await ctx.db.prisma.run.findUnique({ where: { id: run.id } });
    const nodeRuns = await ctx.db.prisma.nodeRun.findMany({ where: { runId: run.id } });
    const byKey = new Map(nodeRuns.map((n) => [n.nodeKey, n]));

    expect(finalRun?.status).toBe('FAILED');
    expect(byKey.get('extract')?.status).toBe('SUCCEEDED');
    expect(byKey.get('preprocess')?.status).toBe('SUCCEEDED');
    expect(byKey.get('train')?.status).toBe('SUCCEEDED');
    expect(byKey.get('evaluate')?.status).toBe('FAILED');
    // The killer assertion: deploy never ran — it never had a chance to,
    // because its only parent failed. SKIPPED, not FAILED (see
    // decisions_log.md — this distinction keeps failure telemetry honest).
    expect(byKey.get('deploy')?.status).toBe('SKIPPED');
    expect(byKey.get('deploy')?.startedAt).toBeNull();
  }, 45_000);
});
