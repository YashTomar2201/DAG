/**
 * B3.4 — Integration: fan-out failure & cancellation cascade (Testcontainers).
 *
 * The per-element subgraph is a single `data.source` whose `csvPath` is the
 * seeded element — a real path SUCCEEDS, a bogus one FAILS — so a graph can
 * dial in exactly which children fail.
 *
 *   A. fail-fast: one failed child cancels its siblings and fails the parent,
 *      skipping the downstream reduce node.
 *   B. tolerate-partial: `failureThreshold` lets the join proceed on a partial
 *      result.
 *   C. cancel cascade: cancelling the parent cancels every child run.
 *   D. retry re-spawns ONLY the failed children (and recovers when the cause is
 *      gone).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { seedWorkflowVersion, cleanupWorkflow, waitUntil } from './fixtures';
import type { Graph } from '@dag/contracts';

const REAL = 'python/data/titanic.csv';

/**
 * `map ── [reduce] ── merge`, with the per-element subgraph being either:
 *   - a single `work` (data.source, csvPath = the seeded element), or
 *   - `gate` (data.source, csvPath = element) → `slow` (model.evaluate, ~2 s)
 *     when `opts.slow` — so a bogus element fails fast at `gate` while its
 *     siblings sit in `slow` long enough to be cancelled.
 */
function graph(
  mapConfig: Record<string, unknown>,
  opts: { reduce?: boolean; slow?: boolean } = {},
): Graph {
  const nodes: Graph['nodes'] = [
    { key: 'map', type: 'flow.map', label: 'Fan out', position: { x: 0, y: 0 }, config: mapConfig as never },
    { key: 'merge', type: 'data.source', label: 'Merge', position: { x: 400, y: 0 }, config: {} },
    { key: 'work', type: 'data.source', label: 'Work', position: { x: 0, y: 150 }, config: { csvPath: '{{ nodes.map.output.item }}' } },
  ];
  const edges: Graph['edges'] = [];
  if (opts.slow) {
    nodes.push({ key: 'slow', type: 'model.evaluate', label: 'Slow', position: { x: 100, y: 150 }, config: { scriptPath: 'evaluate.py' } });
    edges.push({ from: 'work', to: 'slow' });
  }
  if (opts.reduce) {
    nodes.push({ key: 'reduce', type: 'flow.reduce', label: 'Reduce', position: { x: 200, y: 0 }, config: { over: '{{ nodes.map.output.resultsPath }}', mode: 'concat' } });
    edges.push({ from: 'map', to: 'reduce' }, { from: 'reduce', to: 'merge' });
  } else {
    edges.push({ from: 'map', to: 'merge' });
  }
  return { nodes, edges } as Graph;
}

describe('B3.4 — fan-out failure & cancellation', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let stopQueueEvents: () => void;
  let tenantId: string;
  let workflowId: string;
  let nextVersion = 1;
  const runIds: string[] = [];

  const seed = async (g: Graph) => {
    if (nextVersion === 1) {
      const s = await seedWorkflowVersion(ctx.db.prisma, g, 'b34');
      tenantId = s.tenantId;
      workflowId = s.workflowId;
      nextVersion = 2;
      return s.versionId;
    }
    const v = await ctx.db.prisma.workflowVersion.create({
      data: { workflowId, version: nextVersion++, graph: g as unknown as object, topoOrder: {} as unknown as object },
    });
    return v.id;
  };

  const start = async (versionId: string) => {
    const run = await ctx.orchestrator.startRun(versionId);
    runIds.push(run.id);
    return run.id;
  };
  const waitTerminal = (runId: string, want?: string) =>
    waitUntil(
      async () => {
        const r = await ctx.db.prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
        return want ? r?.status === want : r?.status === 'SUCCEEDED' || r?.status === 'FAILED' || r?.status === 'CANCELLED';
      },
      { timeoutMs: 120_000 },
    );
  const children = (parentRunId: string) =>
    ctx.db.prisma.run.findMany({ where: { parentRunId }, orderBy: { fanOutIndex: 'asc' } });
  const nodeRun = (runId: string, nodeKey: string) =>
    ctx.db.prisma.nodeRun.findUnique({ where: { runId_nodeKey: { runId, nodeKey } } });

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();
    stopQueueEvents = ctx.workerEvents.startQueueEventListeners();
  }, 60_000);

  afterAll(async () => {
    stopQueueEvents?.();
    for (const rid of runIds) {
      await ctx.db.prisma.runEvent.deleteMany({ where: { run: { OR: [{ id: rid }, { parentRunId: rid }] } } });
      await ctx.db.prisma.nodeRun.deleteMany({ where: { run: { OR: [{ id: rid }, { parentRunId: rid }] } } });
      await ctx.db.prisma.run.deleteMany({ where: { parentRunId: rid } });
    }
    if (workflowId) await cleanupWorkflow(ctx.db.prisma, tenantId, workflowId);
    await teardownTestEnv(ctx);
  });

  it('A. fail-fast: a failed child cancels siblings and fails the parent, skipping reduce', async () => {
    // index 0 fails at `gate`; the rest pass `gate` and sit ~2 s in `slow`.
    const over = JSON.stringify(['nope-0.csv', ...Array.from({ length: 7 }, () => REAL)]);
    const vid = await seed(
      graph({ overSource: over, subgraph: ['work', 'slow'], failureThreshold: 0 }, { reduce: true, slow: true }),
    );
    const runId = await start(vid);
    await waitTerminal(runId, 'FAILED');

    // Fail-fast tears children down asynchronously across two sweeps; give it a
    // moment to settle rather than racing the last cancel.
    await waitUntil(
      async () =>
        (await ctx.db.prisma.run.count({
          where: { parentRunId: runId, status: { in: ['PENDING', 'RUNNING'] } },
        })) === 0,
      { timeoutMs: 20_000 },
    );

    const kids = await children(runId);
    expect(kids.length).toBeGreaterThanOrEqual(1);
    expect(kids.every((k) => ['FAILED', 'CANCELLED', 'SUCCEEDED'].includes(k.status))).toBe(true);
    expect(kids.some((k) => k.status === 'FAILED')).toBe(true);
    expect(kids.some((k) => k.status === 'CANCELLED')).toBe(true); // siblings cancelled

    expect((await ctx.db.prisma.run.findUnique({ where: { id: runId }, select: { status: true } }))?.status).toBe('FAILED');
    expect((await nodeRun(runId, 'reduce'))?.status).toBe('SKIPPED');
    expect((await nodeRun(runId, 'merge'))?.status).toBe('SKIPPED');
  });

  it('B. tolerate-partial: failureThreshold lets the join proceed on a partial result', async () => {
    const over = JSON.stringify([REAL, REAL, REAL, 'bad-1.csv', 'bad-2.csv', 'bad-3.csv']);
    const vid = await seed(graph({ overSource: over, subgraph: ['work'], failureThreshold: 6 }, { reduce: true }));
    const runId = await start(vid);
    await waitTerminal(runId, 'SUCCEEDED');

    const map = await nodeRun(runId, 'map');
    expect((map!.output as { fanOut: { succeeded: number; failed: number } }).fanOut).toMatchObject({
      succeeded: 3,
      failed: 3,
    });
    expect((await nodeRun(runId, 'reduce'))?.status).toBe('SUCCEEDED');
    expect((await nodeRun(runId, 'merge'))?.status).toBe('SUCCEEDED');
  });

  it('C. cancelling the parent cancels every child run', async () => {
    const over = JSON.stringify(Array.from({ length: 8 }, () => REAL));
    const vid = await seed(graph({ overSource: over, subgraph: ['work', 'slow'] }, { slow: true }));
    const runId = await start(vid);

    await waitUntil(
      async () => {
        const kids = await children(runId);
        return kids.length === 8 && kids.some((k) => k.status === 'RUNNING');
      },
      { timeoutMs: 60_000 },
    );
    const result = await ctx.runService.cancelRunService(runId);
    expect(result.childrenCancelled).toBeGreaterThanOrEqual(1);

    await waitUntil(
      async () => {
        const p = await ctx.db.prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
        const nonTerminal = await ctx.db.prisma.run.count({
          where: { parentRunId: runId, status: { in: ['PENDING', 'RUNNING'] } },
        });
        return p?.status === 'CANCELLED' && nonTerminal === 0;
      },
      { timeoutMs: 30_000 },
    );

    const kids = await children(runId);
    expect(kids.every((k) => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(k.status))).toBe(true);
    expect(kids.some((k) => k.status === 'CANCELLED')).toBe(true);
  });

  it('D. retry re-spawns ONLY the failed children, and recovers', async () => {
    const latePath = path.join(ctx.env.artifactDir, 'b34-late.csv');
    fs.rmSync(latePath, { force: true });
    const over = JSON.stringify([REAL, latePath]);
    const vid = await seed(graph({ overSource: over, subgraph: ['work'], failureThreshold: 0 }));
    const runId = await start(vid);
    await waitTerminal(runId, 'FAILED');

    const kidsBefore = await children(runId);
    expect(kidsBefore).toHaveLength(2);
    const [c0, c1] = kidsBefore;
    expect(c0!.status).toBe('SUCCEEDED');
    expect(c1!.status).toBe('FAILED');
    const c0WorkBefore = await nodeRun(c0!.id, 'work');

    // The cause of c1's failure is now gone.
    fs.writeFileSync(latePath, 'a,b\n1,2\n3,4\n');

    const retry = await ctx.runService.retryFailedNodesService(runId);
    expect(retry.respawnedChildren).toBe(1);

    await waitTerminal(runId, 'SUCCEEDED');

    const kidsAfter = await children(runId);
    const a0 = kidsAfter.find((k) => k.id === c0!.id)!;
    const a1 = kidsAfter.find((k) => k.id === c1!.id)!;
    expect(a0.status).toBe('SUCCEEDED'); // untouched
    expect(a1.status).toBe('SUCCEEDED'); // recovered

    const c0WorkAfter = await nodeRun(c0!.id, 'work');
    expect(c0WorkAfter!.attempt).toBe(c0WorkBefore!.attempt); // survivor not re-run
    expect((await nodeRun(c1!.id, 'work'))!.attempt).toBe(1); // failed child re-run once
    expect((await nodeRun(runId, 'merge'))?.status).toBe('SUCCEEDED');

    fs.rmSync(latePath, { force: true });
  });
});
