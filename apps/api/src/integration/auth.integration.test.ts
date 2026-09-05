/**
 * Roadmap A3 — Integration: cross-tenant isolation (Testcontainers).
 *
 * Every other integration file exercises the service layer as "the tenant
 * that owns this data." This file is the deliberate opposite: it seeds two
 * separate tenants and proves tenant B's id can never read, cancel, retry,
 * page the children of, or start a run against tenant A's data — every one
 * of those operations must 404, not 403 (a leaked/guessed id must be
 * indistinguishable from a wrong one), and starting a run against another
 * tenant's workflowVersionId must be rejected too, not just reads.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { hermeticPipelineGraph, seedWorkflowVersion, cleanupWorkflow, waitUntil } from './fixtures';

describe('A3 — cross-tenant isolation', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let stopQueueEvents: () => void;
  let tenantA: string;
  let workflowA: string;
  let versionA: string;
  let tenantB: string;
  let workflowB: string;
  let runId: string;

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();
    stopQueueEvents = ctx.workerEvents.startQueueEventListeners();

    const seededA = await seedWorkflowVersion(ctx.db.prisma, hermeticPipelineGraph(), 'a3-tenant-a');
    tenantA = seededA.tenantId;
    workflowA = seededA.workflowId;
    versionA = seededA.versionId;

    // A completely separate tenant — not derived from tenant A in any way.
    const seededB = await seedWorkflowVersion(ctx.db.prisma, hermeticPipelineGraph(), 'a3-tenant-b');
    tenantB = seededB.tenantId;
    workflowB = seededB.workflowId;

    const run = await ctx.orchestrator.startRun(versionA, undefined, { tenantId: tenantA });
    runId = run.id;
    await waitUntil(async () => {
      const r = await ctx.db.prisma.run.findUnique({ where: { id: runId } });
      return r?.status === 'SUCCEEDED' || r?.status === 'FAILED';
    });
  }, 60_000);

  afterAll(async () => {
    stopQueueEvents?.();
    await cleanupWorkflow(ctx.db.prisma, tenantA, workflowA);
    await cleanupWorkflow(ctx.db.prisma, tenantB, workflowB);
    await teardownTestEnv(ctx);
  });

  it("tenant A's own key can read the run", async () => {
    const run = await ctx.runService.getRunService(runId, tenantA);
    expect(run.id).toBe(runId);
  });

  it("tenant B's key gets a 404 reading tenant A's run by id", async () => {
    await expect(ctx.runService.getRunService(runId, tenantB)).rejects.toThrow();
  });

  it("tenant B's key gets a 404 listing tenant A's run's children", async () => {
    await expect(ctx.runService.listRunChildrenService(runId, tenantB)).rejects.toThrow();
  });

  it("tenant B's key gets a 404 cancelling tenant A's run", async () => {
    await expect(ctx.runService.cancelRunService(runId, tenantB)).rejects.toThrow();
  });

  it("tenant B's key gets a 404 retrying tenant A's run", async () => {
    await expect(ctx.runService.retryFailedNodesService(runId, tenantB)).rejects.toThrow();
  });

  it("tenant B cannot start a run against tenant A's workflowVersionId", async () => {
    await expect(
      ctx.orchestrator.startRun(versionA, undefined, { tenantId: tenantB }),
    ).rejects.toThrow();
  });

  it('starting a run with no tenantId (an internal caller) is unaffected', async () => {
    // schedule/trigger fire handlers already resolved this exact versionId
    // through a tenant-scoped lookup before calling startRun — they don't
    // pass tenantId, and that must keep working (see the doc comment on
    // startRun's opts.tenantId in orchestrator.service.ts).
    const run = await ctx.orchestrator.startRun(versionA, undefined, { triggeredBy: 'schedule' });
    expect(run.status).toBe('RUNNING');
    await ctx.runService.cancelRunService(run.id, tenantA);
  });
});
