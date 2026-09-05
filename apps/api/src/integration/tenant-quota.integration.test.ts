/**
 * C2.3 — Integration: per-tenant concurrency quota (Testcontainers).
 *
 * `Tenant.concurrencyLimit` bounds how many NodeRuns a tenant may have
 * QUEUED/RUNNING across the cluster at once. Over quota, `dispatchNode`
 * leaves the node PENDING and records it as a "blocked" dispatch instead of
 * enqueueing a BullMQ job; a slot release (`onNodeSucceeded`/`onNodeFailed`)
 * immediately retries one blocked dispatch, so the backlog drains as
 * capacity frees up.
 *
 *   A. a tenant with 4 independent root nodes and a quota of 2 never has more
 *      than 2 in flight at once, and the run still reaches SUCCEEDED with
 *      every node eventually dispatched and every slot released.
 *   B. tenant A saturating its own (low) quota does not delay tenant B's
 *      independent run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { seedWorkflowVersion, cleanupWorkflow, waitUntil, tenantScopedPrisma } from './fixtures';
import type { Graph } from '@dag/contracts';

/** N independent roots — no edges, so `startRun` dispatches all N synchronously in one pass. */
function independentRootsGraph(n: number): Graph {
  return {
    nodes: Array.from({ length: n }, (_, i) => ({
      key: `root${i}`,
      type: 'model.evaluate',
      label: `Root ${i}`,
      position: { x: i * 150, y: 0 },
      // Real sklearn work (~1-2s) — long enough that the dispatch loop
      // finishes well before any node can complete, so the "at most `limit`
      // in flight" assertion isn't racing job execution.
      config: { scriptPath: 'evaluate.py' },
    })),
    edges: [],
  } as unknown as Graph;
}

describe('C2.3 — per-tenant concurrency quota', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let stopQueueEvents: () => void;

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();
    stopQueueEvents = ctx.workerEvents.startQueueEventListeners();
  }, 60_000);

  afterAll(async () => {
    stopQueueEvents?.();
    await teardownTestEnv(ctx);
  });

  it('A. never exceeds the quota in flight, and the run still completes', async () => {
    const seeded = await seedWorkflowVersion(ctx.db, independentRootsGraph(4), 'c23-a');
    const { tenantId, versionId, workflowId } = seeded;
    const db = tenantScopedPrisma(ctx.db, tenantId);

    await ctx.db.prisma.tenant.update({ where: { id: tenantId }, data: { concurrencyLimit: 2 } });

    const run = await ctx.orchestrator.startRun(versionId);

    // Right after startRun returns, its dispatch loop has already run to
    // completion (every dispatchNode call is awaited in sequence) — exactly
    // `limit` nodes should be QUEUED/RUNNING and the rest left PENDING.
    const nodeRuns = await db.nodeRun.findMany({ where: { runId: run.id }, select: { status: true } });
    const inFlight = nodeRuns.filter((n: { status: string }) => ['QUEUED', 'RUNNING'].includes(n.status));
    const pending = nodeRuns.filter((n: { status: string }) => n.status === 'PENDING');
    expect(inFlight).toHaveLength(2);
    expect(pending).toHaveLength(2);

    const activeSlots = await ctx.queue.getTenantActiveSlotCount(tenantId);
    expect(activeSlots).toBe(2);

    await waitUntil(
      async () => {
        const r = await db.run.findUnique({ where: { id: run.id }, select: { status: true } });
        return r?.status === 'SUCCEEDED' || r?.status === 'FAILED';
      },
      { timeoutMs: 60_000 },
    );

    const finalRun = await db.run.findUnique({ where: { id: run.id } });
    expect(finalRun?.status).toBe('SUCCEEDED');

    const finalNodeRuns = await db.nodeRun.findMany({ where: { runId: run.id }, select: { status: true } });
    expect(finalNodeRuns.every((n: { status: string }) => n.status === 'SUCCEEDED')).toBe(true);

    // Every slot released — nothing leaked.
    expect(await ctx.queue.getTenantActiveSlotCount(tenantId)).toBe(0);

    await cleanupWorkflow(ctx.db, tenantId, workflowId);
  }, 90_000);

  it("B. tenant A saturating its quota does not delay tenant B's independent run", async () => {
    const seededA = await seedWorkflowVersion(ctx.db, independentRootsGraph(4), 'c23-b-tenantA');
    const seededB = await seedWorkflowVersion(ctx.db, independentRootsGraph(1), 'c23-b-tenantB');
    const dbA = tenantScopedPrisma(ctx.db, seededA.tenantId);
    const dbB = tenantScopedPrisma(ctx.db, seededB.tenantId);

    // Tenant A: quota of 1 — 3 of its 4 roots will sit blocked the whole time.
    await ctx.db.prisma.tenant.update({ where: { id: seededA.tenantId }, data: { concurrencyLimit: 1 } });

    const runA = await ctx.orchestrator.startRun(seededA.versionId);
    const runB = await ctx.orchestrator.startRun(seededB.versionId);

    // Tenant B has no quota override (default limit, well above its 1 node)
    // and no relationship to tenant A's backlog — it should finish on its
    // own real-work timescale, not be starved by A's blocked nodes.
    await waitUntil(
      async () => {
        const r = await dbB.run.findUnique({ where: { id: runB.id }, select: { status: true } });
        return r?.status === 'SUCCEEDED' || r?.status === 'FAILED';
      },
      { timeoutMs: 20_000 },
    );
    const finalRunB = await dbB.run.findUnique({ where: { id: runB.id } });
    expect(finalRunB?.status).toBe('SUCCEEDED');

    // Tenant A's backlog is still real — assert it eventually drains too,
    // proving the blocked nodes weren't silently dropped, just deferred.
    await waitUntil(
      async () => {
        const r = await dbA.run.findUnique({ where: { id: runA.id }, select: { status: true } });
        return r?.status === 'SUCCEEDED' || r?.status === 'FAILED';
      },
      { timeoutMs: 60_000 },
    );
    const finalRunA = await dbA.run.findUnique({ where: { id: runA.id } });
    expect(finalRunA?.status).toBe('SUCCEEDED');

    await cleanupWorkflow(ctx.db, seededA.tenantId, seededA.workflowId);
    await cleanupWorkflow(ctx.db, seededB.tenantId, seededB.workflowId);
  }, 90_000);
});
