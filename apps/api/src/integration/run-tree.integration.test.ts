/**
 * B3.1 — Integration: run-tree schema + read paths (Testcontainers).
 *
 * Purely additive — nothing about execution changes here. Verifies:
 *   - an ordinary run reports an all-zero `children` summary
 *   - a parented set of runs is counted per-status via one groupBy
 *   - GET /runs/:id/children pages in fanOutIndex order
 *   - an unknown run id 404s
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { hermeticPipelineGraph, seedWorkflowVersion, cleanupWorkflow } from './fixtures';
import type * as RunServiceModule from '../services/run.service';

describe('B3.1 — run tree', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let svc: typeof RunServiceModule;
  let tenantId: string;
  let workflowId: string;
  let versionId: string;
  let parentId: string;

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();
    svc = await import('../services/run.service');
    const seeded = await seedWorkflowVersion(ctx.db.prisma, hermeticPipelineGraph(), 'b31');
    tenantId = seeded.tenantId;
    workflowId = seeded.workflowId;
    versionId = seeded.versionId;

    // A parent run with 5 children inserted out of order: fanOutIndex 3,0,4,1,2
    // with statuses SUCCEEDED×3, FAILED×1, RUNNING×1.
    const parent = await ctx.db.prisma.run.create({
      data: { workflowVersionId: versionId, triggeredBy: 'api', status: 'RUNNING' },
    });
    parentId = parent.id;

    const spec: Array<{ i: number; status: 'SUCCEEDED' | 'FAILED' | 'RUNNING' }> = [
      { i: 3, status: 'SUCCEEDED' },
      { i: 0, status: 'SUCCEEDED' },
      { i: 4, status: 'RUNNING' },
      { i: 1, status: 'FAILED' },
      { i: 2, status: 'SUCCEEDED' },
    ];
    for (const s of spec) {
      await ctx.db.prisma.run.create({
        data: {
          workflowVersionId: versionId,
          triggeredBy: 'fanout',
          parentRunId: parentId,
          fanOutIndex: s.i,
          status: s.status,
        },
      });
    }
  }, 60_000);

  afterAll(async () => {
    await ctx.db.prisma.run.deleteMany({ where: { parentRunId: parentId } });
    await ctx.db.prisma.run.deleteMany({ where: { id: parentId } });
    await cleanupWorkflow(ctx.db.prisma, tenantId, workflowId);
    await teardownTestEnv(ctx);
  });

  it('reports an all-zero children summary for an ordinary run', async () => {
    const plain = await ctx.db.createRun(versionId, 'api', ['extract']);
    const detail = await svc.getRunService(plain.id, tenantId);
    expect(detail.children).toEqual({
      total: 0, pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0,
    });
    await ctx.db.prisma.nodeRun.deleteMany({ where: { runId: plain.id } });
    await ctx.db.prisma.run.delete({ where: { id: plain.id } });
  });

  it('counts children per status with one groupBy', async () => {
    const detail = await svc.getRunService(parentId, tenantId);
    expect(detail.children).toEqual({
      total: 5, pending: 0, running: 1, succeeded: 3, failed: 1, skipped: 0, cancelled: 0,
    });
  });

  it('pages children in fanOutIndex order', async () => {
    const p1 = await svc.listRunChildrenService(parentId, tenantId, { limit: 2 });
    expect(p1.children.map((c) => c.fanOutIndex)).toEqual([0, 1]);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await svc.listRunChildrenService(parentId, tenantId, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.children.map((c) => c.fanOutIndex)).toEqual([2, 3]);
    expect(p2.nextCursor).not.toBeNull();

    const p3 = await svc.listRunChildrenService(parentId, tenantId, { limit: 2, cursor: p2.nextCursor! });
    expect(p3.children.map((c) => c.fanOutIndex)).toEqual([4]);
    expect(p3.nextCursor).toBeNull();

    expect(p3.children[0]!.triggeredBy).toBe('fanout');
  });

  it('404s for an unknown run id', async () => {
    await expect(svc.listRunChildrenService('run-does-not-exist', tenantId)).rejects.toThrow();
    await expect(svc.getRunService('run-does-not-exist', tenantId)).rejects.toThrow();
  });
});
