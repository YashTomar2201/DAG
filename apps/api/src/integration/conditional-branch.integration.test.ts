/**
 * B1.1 — Integration: conditional edges (Testcontainers).
 *
 * `evaluate` (unwired → fixed accuracy 0.923) drives a branch:
 *   evaluate → deploy   [ accuracy gt 0.99 ]  → FALSE → SKIPPED
 *   evaluate → retrain  [ accuracy lte 0.99 ] → TRUE  → SUCCEEDED
 *   deploy → merge, retrain → merge           → diamond re-join; merge still runs
 *
 * Plus: an edge whose condition references a non-existent output aborts the
 * run cleanly (run FAILED, pending nodes SKIPPED — never a hang).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { seedWorkflowVersion, cleanupWorkflow, waitUntil, tenantScopedPrisma } from './fixtures';
import type { Graph } from '@dag/contracts';

function branchGraph(overrides?: { badRef?: boolean }): Graph {
  const deployCond = overrides?.badRef
    ? { left: '{{ nodes.evaluate.output.doesNotExist }}', op: 'gt' as const, right: 0 }
    : { left: '{{ nodes.evaluate.output.accuracy }}', op: 'gt' as const, right: 0.99 };
  return {
    nodes: [
      { key: 'src', type: 'data.source', label: 'Source', position: { x: 0, y: 0 }, config: {} },
      { key: 'evaluate', type: 'model.evaluate', label: 'Evaluate', position: { x: 200, y: 0 }, config: { scriptPath: 'evaluate.py' } },
      { key: 'deploy', type: 'data.source', label: 'Deploy', position: { x: 400, y: -80 }, config: {} },
      { key: 'retrain', type: 'data.source', label: 'Retrain', position: { x: 400, y: 80 }, config: {} },
      { key: 'merge', type: 'data.source', label: 'Merge', position: { x: 600, y: 0 }, config: {} },
    ],
    edges: [
      { from: 'src', to: 'evaluate' },
      { from: 'evaluate', to: 'deploy', condition: deployCond },
      { from: 'evaluate', to: 'retrain', condition: { left: '{{ nodes.evaluate.output.accuracy }}', op: 'lte', right: 0.99 } },
      { from: 'deploy', to: 'merge' },
      { from: 'retrain', to: 'merge' },
    ],
  } as Graph;
}

describe('B1.1 — conditional edges', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let stopQueueEvents: () => void;
  const cleanups: Array<{ tenantId: string; workflowId: string }> = [];

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();
    stopQueueEvents = ctx.workerEvents.startQueueEventListeners();
  }, 60_000);

  afterAll(async () => {
    stopQueueEvents?.();
    for (const c of cleanups) await cleanupWorkflow(ctx.db, c.tenantId, c.workflowId);
    await teardownTestEnv(ctx);
  });

  async function runGraph(graph: Graph, prefix: string) {
    const seeded = await seedWorkflowVersion(ctx.db, graph, prefix);
    cleanups.push({ tenantId: seeded.tenantId, workflowId: seeded.workflowId });
    const db = tenantScopedPrisma(ctx.db, seeded.tenantId);
    const run = await ctx.orchestrator.startRun(seeded.versionId);
    await waitUntil(async () => {
      const r = await db.run.findUnique({ where: { id: run.id } });
      return r?.status === 'FAILED' || r?.status === 'SUCCEEDED';
    });
    const finalRun = await db.run.findUnique({ where: { id: run.id } });
    const nodeRuns = await db.nodeRun.findMany({ where: { runId: run.id } });
    return { status: finalRun?.status, byKey: new Map(nodeRuns.map((n) => [n.nodeKey, n.status])) };
  }

  it('takes exactly one branch; the false one is SKIPPED; the diamond re-joins', async () => {
    const { status, byKey } = await runGraph(branchGraph(), 'b11-branch');

    expect(status).toBe('SUCCEEDED');
    expect(byKey.get('src')).toBe('SUCCEEDED');
    expect(byKey.get('evaluate')).toBe('SUCCEEDED');
    expect(byKey.get('deploy')).toBe('SKIPPED');   // accuracy 0.923 > 0.99 is false
    expect(byKey.get('retrain')).toBe('SUCCEEDED'); // 0.923 <= 0.99 is true
    expect(byKey.get('merge')).toBe('SUCCEEDED');   // reached via retrain's active edge
  }, 60_000);

  it('an unresolvable condition fails the run cleanly (no hang)', async () => {
    const { status, byKey } = await runGraph(branchGraph({ badRef: true }), 'b11-badref');

    expect(status).toBe('FAILED');
    expect(byKey.get('evaluate')).toBe('SUCCEEDED');
    // deploy / retrain / merge never dispatched — swept to SKIPPED by the abort.
    for (const k of ['deploy', 'retrain', 'merge']) {
      expect(['SKIPPED', 'PENDING']).toContain(byKey.get(k));
    }
    // Every node reached a terminal state (nothing left RUNNING/QUEUED).
    for (const s of byKey.values()) {
      expect(['SUCCEEDED', 'FAILED', 'SKIPPED']).toContain(s);
    }
  }, 60_000);
});
