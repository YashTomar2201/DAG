/**
 * Phase 12 — Integration: full pipeline run (Testcontainers, real Postgres + Redis).
 *
 * Acceptance check (build-dag-engine.md, Phase 12):
 *   "Integration with Testcontainers (real Postgres + real Redis): full
 *    pipeline run; ..."
 *
 * This is the least-mocked test in the repo: real Postgres, real Redis, real
 * BullMQ queues, and real `python3` child processes via the Python bridge
 * (apps/worker/python/preprocess.py, train.py, evaluate.py). The `extract`
 * node is `data.source` — it copies the bundled titanic.csv, no creds needed.
 *
 * Execution happens on the two worker OS processes spawned once in
 * global-setup.ts (see that file for why they're shared across every
 * integration test file rather than spawned per-file) — this test is what
 * exercises Phase 8's "2 worker processes" acceptance check.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { hermeticPipelineGraph, seedWorkflowVersion, cleanupWorkflow, waitUntil, tenantScopedPrisma } from './fixtures';

describe('Phase 12 — full pipeline run (real Postgres + Redis + 2 shared workers)', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let stopQueueEvents: () => void;
  let tenantId: string;
  let workflowId: string;
  let versionId: string;
  let db: ReturnType<typeof tenantScopedPrisma>;

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();

    // The control plane's completion loop: consumes BullMQ QueueEvents and
    // calls onNodeSucceeded/onNodeFailed. In production this runs inside the
    // API process; here it runs inside the test process for the same reason
    // — apps/api IS the control plane.
    stopQueueEvents = ctx.workerEvents.startQueueEventListeners();

    const seeded = await seedWorkflowVersion(ctx.db, hermeticPipelineGraph(), 'full-pipeline');
    tenantId = seeded.tenantId;
    workflowId = seeded.workflowId;
    versionId = seeded.versionId;
    db = tenantScopedPrisma(ctx.db, tenantId);
  }, 60_000);

  afterAll(async () => {
    stopQueueEvents?.();
    await cleanupWorkflow(ctx.db, tenantId, workflowId);
    await teardownTestEnv(ctx);
  });

  it('runs all five nodes to SUCCEEDED in topological order with resolved templates', async () => {
    const run = await ctx.orchestrator.startRun(versionId);
    expect(run.status).toBe('RUNNING');

    await waitUntil(async () => {
      const r = await db.run.findUnique({ where: { id: run.id } });
      return r?.status === 'SUCCEEDED' || r?.status === 'FAILED';
    });

    const finalRun = await db.run.findUnique({ where: { id: run.id } });
    const nodeRuns = await db.nodeRun.findMany({
      where: { runId: run.id },
      orderBy: { nodeKey: 'asc' },
    });

    // Print node errors for debuggability if the run failed.
    if (finalRun?.status !== 'SUCCEEDED') {
      console.error('Run did not succeed:', JSON.stringify(nodeRuns, null, 2));
    }

    expect(finalRun?.status).toBe('SUCCEEDED');
    expect(nodeRuns).toHaveLength(5);
    expect(nodeRuns.every((n) => n.status === 'SUCCEEDED')).toBe(true);

    // ── Topological ordering proof ──────────────────────────────────────
    // Every node's startedAt must be >= its parent's finishedAt.
    const byKey = new Map(nodeRuns.map((n) => [n.nodeKey, n]));
    const edges: [string, string][] = [
      ['extract', 'preprocess'],
      ['preprocess', 'train'],
      ['train', 'evaluate'],
      ['evaluate', 'deploy'],
    ];
    for (const [parent, child] of edges) {
      const p = byKey.get(parent)!;
      const c = byKey.get(child)!;
      expect(c.startedAt!.getTime()).toBeGreaterThanOrEqual(p.finishedAt!.getTime());
    }

    // ── Context passing proof (Phase 7) ─────────────────────────────────
    // deploy's persisted `input.weightsPath` must be the LITERAL value from
    // train's output, not the "{{ nodes.train.output.weightsPath }}" template.
    const deploy = byKey.get('deploy')!;
    const train = byKey.get('train')!;
    const trainOutput = train.output as { weightsPath: string };
    expect((deploy.output as { weightsPath: string }).weightsPath).toBe(trainOutput.weightsPath);
    expect((deploy.output as { weightsPath: string }).weightsPath).not.toContain('{{');
  }, 45_000);
});
