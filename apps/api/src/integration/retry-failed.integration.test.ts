/**
 * Phase 12 — Integration: retry-failed (Testcontainers).
 *
 * Forces `evaluate` to fail (same trick as failure-propagation.integration.test.ts —
 * evaluate.py always reports accuracy 0.923, so a minAccuracy above that
 * rejects it), lets the run reach FAILED with `deploy` SKIPPED, then calls
 * `retryFailedNodesService` and proves the run actually recovers to
 * SUCCEEDED — not just that the DB rows flip back to PENDING.
 *
 * Writing this test is what surfaced a real bug: `retryFailedNodesService`
 * reset FAILED rows to PENDING but never re-dispatched them, so retried runs
 * hung forever. Fixed in apps/api/src/services/run.service.ts — see
 * decisions_log.md "Phase 12 — retry-failed never dispatched" for the why/how.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { hermeticPipelineGraph, seedWorkflowVersion, cleanupWorkflow, waitUntil } from './fixtures';
import type { Graph } from '@dag/contracts';

describe('Phase 12 — retry-failed recovers a FAILED run to SUCCEEDED', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let stopQueueEvents: () => void;
  let tenantId: string;
  let workflowId: string;
  let versionId: string;
  let graph: Graph;

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();

    // Execution happens on the shared worker processes spawned once in
    // global-setup.ts — see that file for why.
    stopQueueEvents = ctx.workerEvents.startQueueEventListeners();

    graph = hermeticPipelineGraph();
    const evaluateNode = graph.nodes.find((n) => n.key === 'evaluate')!;
    (evaluateNode.config as Record<string, unknown>)['minAccuracy'] = 0.99; // fails on attempt 0 (0.923 < 0.99)

    const seeded = await seedWorkflowVersion(ctx.db.prisma, graph, 'retry-failed');
    tenantId = seeded.tenantId;
    workflowId = seeded.workflowId;
    versionId = seeded.versionId;
  }, 60_000);

  afterAll(async () => {
    stopQueueEvents?.();
    await cleanupWorkflow(ctx.db.prisma, tenantId, workflowId);
    await teardownTestEnv(ctx);
  });

  it('fails, then recovers after retry-failed', async () => {
    const run = await ctx.orchestrator.startRun(versionId);

    await waitUntil(async () => {
      const r = await ctx.db.prisma.run.findUnique({ where: { id: run.id } });
      return r?.status === 'FAILED';
    });

    let nodeRuns = await ctx.db.prisma.nodeRun.findMany({ where: { runId: run.id } });
    expect(nodeRuns.find((n) => n.nodeKey === 'evaluate')?.status).toBe('FAILED');
    expect(nodeRuns.find((n) => n.nodeKey === 'deploy')?.status).toBe('SKIPPED');
    const evaluateAttemptBefore = nodeRuns.find((n) => n.nodeKey === 'evaluate')!.attempt;

    // "Fix the bug" the way a human would — the threshold was unreasonably
    // strict for what this model actually scores, so lower it and persist
    // the patch onto the SAME version's graph column. dispatchNode reads
    // `minAccuracy` straight off `node.config` (not templated, not cached
    // from the failed attempt — see executors.ts's modelEvaluate), so the
    // retried attempt picks up the fix automatically.
    const evaluateNode = graph.nodes.find((n) => n.key === 'evaluate')!;
    (evaluateNode.config as Record<string, unknown>)['minAccuracy'] = 0.5; // 0.923 now clears the bar
    await ctx.db.prisma.workflowVersion.update({
      where: { id: versionId },
      data: { graph: graph as unknown as object },
    });

    const result = await ctx.runService.retryFailedNodesService(run.id, tenantId);
    expect(result.retried).toBe(1);
    expect(result.resetSkipped).toBe(1);

    await waitUntil(async () => {
      const r = await ctx.db.prisma.run.findUnique({ where: { id: run.id } });
      return r?.status === 'SUCCEEDED' || r?.status === 'FAILED';
    });

    const finalRun = await ctx.db.prisma.run.findUnique({ where: { id: run.id } });
    nodeRuns = await ctx.db.prisma.nodeRun.findMany({ where: { runId: run.id } });
    const byKey = new Map(nodeRuns.map((n) => [n.nodeKey, n]));

    expect(finalRun?.status).toBe('SUCCEEDED');
    expect(byKey.get('evaluate')?.status).toBe('SUCCEEDED');
    expect(byKey.get('evaluate')?.attempt).toBe(evaluateAttemptBefore + 1);
    expect(byKey.get('deploy')?.status).toBe('SUCCEEDED');
  }, 45_000);
});
