/**
 * Phase 3 — Persistence layer acceptance test
 *
 * Acceptance check (from build-dag-engine.md):
 *   "A test creates a run, then calls tryTransitionNodeRun(id, 'PENDING', 'QUEUED')
 *    twice — first returns `true`, second returns `false`, and the row is unchanged."
 *
 * This test runs against a real PostgreSQL database (provided by DATABASE_URL env).
 * It is skipped when DATABASE_URL is not set so the CI unit-test pass remains clean.
 *
 * To run against a live DB:
 *   DATABASE_URL=postgresql://... pnpm --filter @dag/db test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  prisma,
  withTenant,
  createRun,
  tryTransitionNodeRun,
  findNodeRun,
  tryTransitionRun,
} from './index';

// ─── Guard: skip if no real DB is configured ─────────────────────────────────
const HAS_DB = Boolean(process.env['DATABASE_URL']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates the minimal rows needed to seed a Run (Tenant → Workflow → Version → Run) */
async function seedTestRun(
  nodeKeys: string[],
): Promise<{ runId: string; tenantId: string; nodeRunIds: Map<string, string> }> {
  // Tenant
  const tenant = await prisma.tenant.create({ data: { name: `test-tenant-${Date.now()}` } });

  // Workflow — Workflow is RLS-protected (roadmap C2.1), so this insert must
  // run inside a transaction scoped to the tenant it's checked against.
  const workflow = await withTenant(tenant.id, (tx) =>
    tx.workflow.create({
      data: { tenantId: tenant.id, name: 'Test Workflow' },
    }),
  );

  // WorkflowVersion (minimal graph + topoOrder)
  const version = await prisma.workflowVersion.create({
    data: {
      workflowId: workflow.id,
      version: 1,
      graph: { nodes: nodeKeys.map((k) => ({ key: k })), edges: [] },
      topoOrder: { order: nodeKeys, tiers: [nodeKeys] },
    },
  });

  // Run + NodeRuns
  const run = await createRun(version.id, tenant.id, 'test', nodeKeys);

  // Collect nodeRun ids
  const nodeRunIds = new Map<string, string>();
  for (const key of nodeKeys) {
    const nr = await findNodeRun(run.id, key, tenant.id);
    if (nr) nodeRunIds.set(key, nr.id);
  }

  return { runId: run.id, tenantId: tenant.id, nodeRunIds };
}

/** Cleans up all rows created by the test (top-down cascade) */
async function cleanupRun(runId: string, tenantId: string) {
  const run = await withTenant(tenantId, async (tx) => {
    await tx.runEvent.deleteMany({ where: { runId } });
    await tx.nodeRun.deleteMany({ where: { runId } });
    const r = await tx.run.findUnique({ where: { id: runId }, select: { workflowVersionId: true } });
    await tx.run.delete({ where: { id: runId } });
    return r;
  });
  if (run) {
    // WorkflowVersion/Workflow: WorkflowVersion isn't RLS-protected; Workflow
    // is, so its delete needs the same tenant context.
    const version = await prisma.workflowVersion.findUnique({
      where: { id: run.workflowVersionId },
      select: { workflowId: true },
    });
    await prisma.workflowVersion.delete({ where: { id: run.workflowVersionId } });
    if (version) {
      await withTenant(tenantId, (tx) => tx.workflow.delete({ where: { id: version.workflowId } }));
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)('Phase 3 — Persistence layer (requires real DB)', () => {
  let runId: string;
  let tenantId: string;
  let nodeRunId: string;

  beforeAll(async () => {
    const { runId: rid, tenantId: tid, nodeRunIds } = await seedTestRun(['extract', 'preprocess']);
    runId = rid;
    tenantId = tid;
    nodeRunId = nodeRunIds.get('extract')!;
  });

  afterAll(async () => {
    await cleanupRun(runId, tenantId);
    await prisma.$disconnect();
  });

  // ── Core acceptance check ─────────────────────────────────────────────────

  it('tryTransitionNodeRun: first call PENDING→QUEUED returns true', async () => {
    const result = await tryTransitionNodeRun(nodeRunId, 'PENDING', 'QUEUED', tenantId);
    expect(result).toBe(true);
  });

  it('tryTransitionNodeRun: second call PENDING→QUEUED returns false (already QUEUED)', async () => {
    // The row is now QUEUED; trying PENDING→QUEUED again should fail
    const result = await tryTransitionNodeRun(nodeRunId, 'PENDING', 'QUEUED', tenantId);
    expect(result).toBe(false);
  });

  it('the NodeRun row is still QUEUED after the failed second transition', async () => {
    const nr = await withTenant(tenantId, (tx) => tx.nodeRun.findUnique({ where: { id: nodeRunId } }));
    expect(nr?.status).toBe('QUEUED');
  });

  // ── Additional conditional-update paths ───────────────────────────────────

  it('tryTransitionNodeRun: QUEUED→RUNNING with workerId succeeds', async () => {
    const result = await tryTransitionNodeRun(nodeRunId, 'QUEUED', 'RUNNING', tenantId, {
      workerId: 'worker-1',
      startedAt: new Date(),
    });
    expect(result).toBe(true);

    const nr = await withTenant(tenantId, (tx) => tx.nodeRun.findUnique({ where: { id: nodeRunId } }));
    expect(nr?.status).toBe('RUNNING');
    expect(nr?.workerId).toBe('worker-1');
  });

  it('tryTransitionNodeRun: RUNNING→SUCCEEDED with output succeeds', async () => {
    const output = { rows: 1000, metadataPath: `artifacts/${runId}/extract/data.csv` };
    const result = await tryTransitionNodeRun(nodeRunId, 'RUNNING', 'SUCCEEDED', tenantId, {
      output,
      finishedAt: new Date(),
    });
    expect(result).toBe(true);

    const nr = await withTenant(tenantId, (tx) => tx.nodeRun.findUnique({ where: { id: nodeRunId } }));
    expect(nr?.status).toBe('SUCCEEDED');
    expect(nr?.output).toEqual(output);
  });

  // ── Run-level transition ───────────────────────────────────────────────────

  it('tryTransitionRun: PENDING→RUNNING succeeds', async () => {
    const result = await tryTransitionRun(runId, 'PENDING', 'RUNNING', tenantId, {
      startedAt: new Date(),
    });
    expect(result).toBe(true);
  });

  it('tryTransitionRun: PENDING→RUNNING a second time returns false', async () => {
    const result = await tryTransitionRun(runId, 'PENDING', 'RUNNING', tenantId);
    expect(result).toBe(false);
  });

  // ── Unique constraint: @@unique([runId, nodeKey]) ──────────────────────────

  it('createMany would reject a duplicate (runId, nodeKey) via DB constraint', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.nodeRun.createMany({
          data: [{ runId, tenantId, nodeKey: 'extract', status: 'PENDING', attempt: 0 }],
        }),
      ),
    ).rejects.toThrow();
  });
});
