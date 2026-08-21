/**
 * Shared graph fixtures for the Phase 12 integration suite.
 *
 * `hermeticPipelineGraph()` mirrors the PROJECT_GUIDE reference ML pipeline
 * (extract → preprocess → train → evaluate → deploy) in shape and semantics,
 * but the `extract` node is `pandas.preprocess` rather than `kaggle.download`.
 *
 * Why the substitution: `kaggleDownload` (apps/worker/src/executors.ts)
 * shells out to the real `kaggle` CLI, which needs network access and a
 * credentialed account — neither is available (or desirable) in a hermetic
 * test/CI environment, and Testcontainers gives us a fresh `runId` only
 * *after* the run starts, so we cannot deterministically pre-seed its
 * idempotency cache file ahead of dispatch. Every other executor
 * (`pandas.preprocess`, `torch.train`, `model.evaluate`, `registry.deploy`)
 * does real local work (spawns the real fixture scripts in
 * `apps/worker/python/`, writes real files, computes a real checksum) with
 * zero external dependencies, so swapping just the entry node keeps every
 * other part of the system — topological dispatch, template resolution, all
 * three BullMQ queues, atomic in-degree decrement, idempotent writes —
 * exercised for real. See decisions_log.md for the full write-up.
 *
 * Note: `evaluate.py` always reports a fixed accuracy of 0.923 (no kwargs
 * knob) — tests that need `model.evaluate` to fail do so via `minAccuracy`
 * on the node config, not by asking the script for a different number.
 */
import type { Graph } from '@dag/contracts';
import { topologicalSort } from '@dag/graph-core';
import type { prisma as PrismaInstance } from '@dag/db';

type Prisma = typeof PrismaInstance;

export function hermeticPipelineGraph(): Graph {
  return {
    nodes: [
      {
        key: 'extract',
        type: 'pandas.preprocess',
        label: 'Extract (fixture)',
        position: { x: 0, y: 0 },
        config: { scriptPath: 'preprocess.py' },
      },
      {
        key: 'preprocess',
        type: 'pandas.preprocess',
        label: 'Preprocess',
        position: { x: 200, y: 0 },
        // Template-references extract's real output field ("rows": 100,
        // hardcoded by preprocess.py) — proves Phase 7 context passing end
        // to end even though this particular fixture script ignores kwargs.
        config: { scriptPath: 'preprocess.py', kwargs: { rows: '{{ nodes.extract.output.rows }}' } },
      },
      {
        key: 'train',
        type: 'torch.train',
        label: 'Train',
        position: { x: 400, y: 0 },
        config: { scriptPath: 'train.py', epochs: 2 },
      },
      {
        key: 'evaluate',
        type: 'model.evaluate',
        label: 'Evaluate',
        position: { x: 600, y: 0 },
        config: { scriptPath: 'evaluate.py' },
      },
      {
        key: 'deploy',
        type: 'registry.deploy',
        label: 'Deploy',
        position: { x: 800, y: 0 },
        config: {
          registryUrl: 'https://registry.example.internal',
          modelTag: 'test-model',
          // Not part of RegistryDeployConfigSchema's typed fields, but the
          // resolver walks the whole config object — see context-resolver.ts.
          // registryDeploy() reads this off ctx.input at execution time.
          weightsPath: '{{ nodes.train.output.weightsPath }}',
        },
      },
    ],
    edges: [
      { from: 'extract', to: 'preprocess' },
      { from: 'preprocess', to: 'train' },
      { from: 'train', to: 'evaluate' },
      { from: 'evaluate', to: 'deploy' },
    ],
  } as Graph;
}

/** The diamond graph used by the race-condition and Lua tests. */
export function diamondGraph(): Graph {
  return {
    nodes: [
      { key: 'a', type: 'pandas.preprocess', label: 'A', position: { x: 0, y: 0 }, config: { scriptPath: 'preprocess.py' } },
      { key: 'b', type: 'pandas.preprocess', label: 'B', position: { x: 200, y: -100 }, config: { scriptPath: 'preprocess.py' } },
      { key: 'c', type: 'pandas.preprocess', label: 'C', position: { x: 200, y: 100 }, config: { scriptPath: 'preprocess.py' } },
      { key: 'd', type: 'model.evaluate', label: 'D', position: { x: 400, y: 0 }, config: { scriptPath: 'evaluate.py' } },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' },
    ],
  } as Graph;
}

/**
 * Seeds a Tenant → Workflow → WorkflowVersion for the given graph, computing
 * and caching topoOrder exactly as `POST /workflows/:id/versions` does in
 * Phase 4 (validate once, cache forever — see architecture.md).
 */
export async function seedWorkflowVersion(
  prisma: Prisma,
  graph: Graph,
  namePrefix: string,
) {
  const tenant = await prisma.tenant.create({ data: { name: `${namePrefix}-tenant-${Date.now()}` } });
  const workflow = await prisma.workflow.create({
    data: { tenantId: tenant.id, name: `${namePrefix}-workflow` },
  });
  const topoOrder = topologicalSort(graph);
  const version = await prisma.workflowVersion.create({
    data: {
      workflowId: workflow.id,
      version: 1,
      graph: graph as unknown as object,
      topoOrder: topoOrder as unknown as object,
    },
  });

  return { tenantId: tenant.id, workflowId: workflow.id, versionId: version.id, topoOrder };
}

/** Deletes a Run and everything under it, plus its Workflow/Tenant ancestry. */
export async function cleanupWorkflow(
  prisma: Prisma,
  tenantId: string,
  workflowId: string,
) {
  const versions = await prisma.workflowVersion.findMany({ where: { workflowId }, select: { id: true } });
  const versionIds = versions.map((v) => v.id);
  const runs = await prisma.run.findMany({ where: { workflowVersionId: { in: versionIds } }, select: { id: true } });
  const runIds = runs.map((r) => r.id);

  await prisma.runEvent.deleteMany({ where: { runId: { in: runIds } } });
  await prisma.nodeRun.deleteMany({ where: { runId: { in: runIds } } });
  await prisma.run.deleteMany({ where: { id: { in: runIds } } });
  await prisma.workflowVersion.deleteMany({ where: { workflowId } });
  await prisma.workflow.delete({ where: { id: workflowId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}

/** Polls until `predicate` returns true or `timeoutMs` elapses. */
export async function waitUntil(
  predicate: () => Promise<boolean>,
  { timeoutMs = 20_000, intervalMs = 150 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}
