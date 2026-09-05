/**
 * D1.1 — Integration: Workflow CRUD (Testcontainers).
 *
 * Exercises the service layer against a real Postgres:
 *   create ×3 → list (newest-first, versionCount, lastRunAt) → paginate →
 *   rename (no new version) → soft-delete → gone from list, 404 on read,
 *   but the deleted workflow's run is still readable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { hermeticPipelineGraph } from './fixtures';
import { topologicalSort } from '@dag/graph-core';
import type * as WfServiceModule from '../services/workflow.service';

describe('D1.1 — Workflow CRUD', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let wfService: typeof WfServiceModule;
  let runService: Awaited<ReturnType<typeof bootstrapTestEnv>>['runService'];
  let tenantId: string;
  const ids: string[] = [];
  let runIdForWf2: string;

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();
    wfService = await import('../services/workflow.service');
    runService = ctx.runService;

    tenantId = `d11-${Date.now()}`;
    const graph = hermeticPipelineGraph();
    const topo = topologicalSort(graph);

    // Three workflows, oldest first. Small sleeps keep createdAt strictly ordered.
    for (const name of ['alpha', 'bravo', 'charlie']) {
      const { workflowId, versionId } = await ctx.db.createWorkflow(tenantId, name, graph, topo);
      ids.push(workflowId);
      if (name === 'bravo') {
        const run = await ctx.db.createRun(versionId, 'api', graph.nodes.map((n) => n.key));
        // lastRunAt is derived from Run.startedAt — mark it started.
        await ctx.db.prisma.run.update({ where: { id: run.id }, data: { startedAt: new Date() } });
        runIdForWf2 = run.id;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }, 60_000);

  afterAll(async () => {
    // Hard-delete everything this test made (works regardless of deletedAt).
    const versions = await ctx.db.prisma.workflowVersion.findMany({
      where: { workflowId: { in: ids } },
      select: { id: true },
    });
    const vIds = versions.map((v) => v.id);
    const runs = await ctx.db.prisma.run.findMany({
      where: { workflowVersionId: { in: vIds } },
      select: { id: true },
    });
    const rIds = runs.map((r) => r.id);
    await ctx.db.prisma.runEvent.deleteMany({ where: { runId: { in: rIds } } });
    await ctx.db.prisma.nodeRun.deleteMany({ where: { runId: { in: rIds } } });
    await ctx.db.prisma.run.deleteMany({ where: { id: { in: rIds } } });
    await ctx.db.prisma.workflowVersion.deleteMany({ where: { workflowId: { in: ids } } });
    await ctx.db.prisma.workflow.deleteMany({ where: { id: { in: ids } } });
    await ctx.db.prisma.tenant.deleteMany({ where: { id: tenantId } });
    await teardownTestEnv(ctx);
  });

  it('lists tenant workflows newest-first with versionCount and lastRunAt', async () => {
    const { workflows, nextCursor } = await wfService.listWorkflowsService(tenantId);
    expect(workflows.map((w) => w.name)).toEqual(['charlie', 'bravo', 'alpha']);
    expect(workflows.every((w) => w.versionCount === 1)).toBe(true);
    expect(nextCursor).toBeNull();

    // Only 'bravo' has a run.
    const bravo = workflows.find((w) => w.name === 'bravo')!;
    const alpha = workflows.find((w) => w.name === 'alpha')!;
    expect(bravo.lastRunAt).not.toBeNull();
    expect(alpha.lastRunAt).toBeNull();
  });

  it('paginates by cursor', async () => {
    const first = await wfService.listWorkflowsService(tenantId, { limit: 2 });
    expect(first.workflows.map((w) => w.name)).toEqual(['charlie', 'bravo']);
    expect(first.nextCursor).not.toBeNull();

    const second = await wfService.listWorkflowsService(tenantId, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.workflows.map((w) => w.name)).toEqual(['alpha']);
    expect(second.nextCursor).toBeNull();
  });

  it('rename changes the name without creating a version', async () => {
    const updated = await wfService.renameWorkflowService(ids[0]!, tenantId, 'alpha-renamed');
    expect(updated.name).toBe('alpha-renamed');

    const detail = await wfService.getWorkflowService(ids[0]!, tenantId);
    expect(detail.name).toBe('alpha-renamed');
    expect(detail.versions).toHaveLength(1);
  });

  it('cross-tenant read is a 404', async () => {
    await expect(wfService.getWorkflowService(ids[0]!, 'someone-else')).rejects.toThrow();
  });

  it('soft-delete removes it from the list but keeps its runs readable', async () => {
    await wfService.deleteWorkflowService(ids[1]!, tenantId); // 'bravo', the one with a run

    const { workflows } = await wfService.listWorkflowsService(tenantId);
    expect(workflows.map((w) => w.name).sort()).toEqual(['alpha-renamed', 'charlie']);

    await expect(wfService.getWorkflowService(ids[1]!, tenantId)).rejects.toThrow();
    await expect(wfService.listWorkflowVersionsService(ids[1]!, tenantId)).rejects.toThrow();

    // The run of the deleted workflow is still readable by id.
    const run = await runService.getRunService(runIdForWf2, tenantId);
    expect(run.id).toBe(runIdForWf2);
    expect(run.nodeRuns.length).toBeGreaterThan(0);
  });

  it('deleting an already-deleted workflow is a 404', async () => {
    await expect(wfService.deleteWorkflowService(ids[1]!, tenantId)).rejects.toThrow();
  });
});
