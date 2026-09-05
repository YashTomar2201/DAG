/**
 * Phase 12 — Integration: cancellation mid-run (Testcontainers).
 *
 * Cancels a run right after its first node succeeds — while later nodes are
 * queued/running — and proves the downstream branch never reaches
 * SUCCEEDED. The real BullMQ `.remove()` call in `cancelRunService`
 * (apps/api/src/services/run.service.ts) drains pending jobs; any node
 * already RUNNING has its DB row flipped to CANCELLED, so when the worker's
 * completion event does arrive, `onNodeSucceeded`'s conditional-update guard
 * (`status !== 'RUNNING'`) silently discards it instead of resurrecting the
 * node.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { hermeticPipelineGraph, seedWorkflowVersion, cleanupWorkflow, waitUntil } from './fixtures';
import type { Graph } from '@dag/contracts';

describe('Phase 12 — cancellation mid-run', () => {
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

    // Slow `train` down (more simulated epochs) so it is reliably still
    // in-flight — not already finished — by the time cancel() is called.
    // Without this, the fixture scripts are fast enough that the whole
    // pipeline can race to completion before the cancel request lands,
    // which would make this test pass for the wrong reason (nothing left
    // to cancel) instead of proving cancellation actually stops in-flight work.
    const graph = hermeticPipelineGraph();
    const trainNode = graph.nodes.find((n) => n.key === 'train')!;
    (trainNode.config as Record<string, unknown>)['epochs'] = 100; // ~2s of simulated training

    const seeded = await seedWorkflowVersion(ctx.db.prisma, graph as Graph, 'cancellation');
    tenantId = seeded.tenantId;
    workflowId = seeded.workflowId;
    versionId = seeded.versionId;
  }, 60_000);

  afterAll(async () => {
    stopQueueEvents?.();
    await cleanupWorkflow(ctx.db.prisma, tenantId, workflowId);
    await teardownTestEnv(ctx);
  });

  it('stops the run: no node reachable only through the cancelled branch ever succeeds', async () => {
    const run = await ctx.orchestrator.startRun(versionId);

    // Wait for the first node to complete — proves the run is genuinely
    // in-flight (not cancelled before anything happened).
    await waitUntil(async () => {
      const nr = await ctx.db.prisma.nodeRun.findUnique({
        where: { runId_nodeKey: { runId: run.id, nodeKey: 'extract' } },
      });
      return nr?.status === 'SUCCEEDED';
    });

    const result = await ctx.runService.cancelRunService(run.id, tenantId);
    expect(result.alreadyTerminal).toBe(false);
    expect(result.status).toBe('CANCELLED');

    // Give any already-dispatched-but-not-yet-observed job a moment to
    // finish and report back, so we're asserting against settled state,
    // not a timing coincidence.
    await new Promise((r) => setTimeout(r, 2000));

    const finalRun = await ctx.db.prisma.run.findUnique({ where: { id: run.id } });
    const nodeRuns = await ctx.db.prisma.nodeRun.findMany({ where: { runId: run.id } });
    const byKey = new Map(nodeRuns.map((n) => [n.nodeKey, n]));
    const terminalNonRunning = ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'];

    expect(finalRun?.status).toBe('CANCELLED');
    // `extract` had already succeeded before cancel — cancellation must not
    // retroactively undo completed work.
    expect(byKey.get('extract')?.status).toBe('SUCCEEDED');
    // deploy — the last node — must never have reached SUCCEEDED: either it
    // was still PENDING and got CANCELLED directly, or (if the scheduler was
    // unusually fast) it was QUEUED/RUNNING and got CANCELLED too.
    expect(byKey.get('deploy')?.status).not.toBe('SUCCEEDED');
    // Every NodeRun must have landed in a terminal state — cancellation must
    // not leave the run stuck with a PENDING/QUEUED row forever.
    for (const nr of nodeRuns) {
      expect(terminalNonRunning).toContain(nr.status);
    }
  }, 45_000);
});
