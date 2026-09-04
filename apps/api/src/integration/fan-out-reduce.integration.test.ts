/**
 * B3.3 — Integration: fan-out output aggregation (Testcontainers).
 *
 * Graph:  split ── map (flow.map) ── reduce (flow.reduce) ── merge
 *         + detached `work` (data.source) = the per-element subgraph
 *
 * At the join the orchestrator writes every child's `work` output, ordered by
 * fanOutIndex, to a results file and exposes its path as
 * `map.output.resultsPath`. The `flow.reduce` node reads it and folds.
 *
 * Asserts the B3.3 "done when": a reduce node computes a real aggregate over
 * every child's output, and the collected array never touches the map node's
 * own output (so it is cap-safe for any N).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { seedWorkflowVersion, cleanupWorkflow, waitUntil } from './fixtures';
import type { Graph } from '@dag/contracts';

function reduceGraph(mode: 'mean' | 'concat'): Graph {
  return {
    nodes: [
      { key: 'split', type: 'data.source', label: 'Split', position: { x: 0, y: 0 }, config: {} },
      {
        key: 'map',
        type: 'flow.map',
        label: 'Fan out',
        position: { x: 200, y: 0 },
        config: { overSource: '{{ nodes.split.output.columns }}', subgraph: ['work'], maxFanOut: 50 },
      },
      {
        key: 'reduce',
        type: 'flow.reduce',
        label: 'Reduce',
        position: { x: 400, y: 0 },
        config:
          mode === 'mean'
            ? { over: '{{ nodes.map.output.resultsPath }}', mode: 'mean', field: 'rows' }
            : { over: '{{ nodes.map.output.resultsPath }}', mode: 'concat' },
      },
      { key: 'merge', type: 'data.source', label: 'Merge', position: { x: 600, y: 0 }, config: {} },
      { key: 'work', type: 'data.source', label: 'Work', position: { x: 200, y: 150 }, config: {} },
    ],
    edges: [
      { from: 'split', to: 'map' },
      { from: 'map', to: 'reduce' },
      { from: 'reduce', to: 'merge' },
    ],
  } as Graph;
}

async function runToTerminal(
  ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>,
  versionId: string,
): Promise<string> {
  const run = await ctx.orchestrator.startRun(versionId);
  await waitUntil(
    async () => {
      const r = await ctx.db.prisma.run.findUnique({ where: { id: run.id }, select: { status: true } });
      return r?.status === 'SUCCEEDED' || r?.status === 'FAILED';
    },
    { timeoutMs: 120_000 },
  );
  return run.id;
}

describe('B3.3 — fan-out reduce', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let stopQueueEvents: () => void;
  let tenantId: string;
  let workflowId: string;
  let meanRunId: string;
  let concatRunId: string;
  let columnCount = 0;
  let rowsPerChild = 0;

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();
    stopQueueEvents = ctx.workerEvents.startQueueEventListeners();

    const seededMean = await seedWorkflowVersion(ctx.db.prisma, reduceGraph('mean'), 'b33m');
    tenantId = seededMean.tenantId;
    workflowId = seededMean.workflowId;
    meanRunId = await runToTerminal(ctx, seededMean.versionId);

    const seededConcat = await ctx.db.prisma.workflowVersion.create({
      data: {
        workflowId,
        version: 2,
        graph: reduceGraph('concat') as unknown as object,
        topoOrder: {} as unknown as object,
      },
    });
    concatRunId = await runToTerminal(ctx, seededConcat.id);

    const split = await ctx.db.prisma.nodeRun.findUnique({
      where: { runId_nodeKey: { runId: meanRunId, nodeKey: 'split' } },
      select: { output: true },
    });
    columnCount = ((split?.output as { columns?: unknown[] })?.columns ?? []).length;

    const oneWork = await ctx.db.prisma.nodeRun.findFirst({
      where: { run: { parentRunId: meanRunId }, nodeKey: 'work', status: 'SUCCEEDED' },
      select: { output: true },
    });
    rowsPerChild = (oneWork?.output as { rows?: number })?.rows ?? 0;
  }, 300_000);

  afterAll(async () => {
    stopQueueEvents?.();
    for (const rid of [meanRunId, concatRunId]) {
      await ctx.db.prisma.runEvent.deleteMany({
        where: { run: { OR: [{ id: rid }, { parentRunId: rid }] } },
      });
      await ctx.db.prisma.nodeRun.deleteMany({
        where: { run: { OR: [{ id: rid }, { parentRunId: rid }] } },
      });
      await ctx.db.prisma.run.deleteMany({ where: { parentRunId: rid } });
    }
    await cleanupWorkflow(ctx.db.prisma, tenantId, workflowId);
    await teardownTestEnv(ctx);
  });

  it('collects every child output into a results file, ordered by fanOutIndex', async () => {
    expect(columnCount).toBeGreaterThan(5);
    expect(rowsPerChild).toBeGreaterThan(0);

    const map = await ctx.db.prisma.nodeRun.findUnique({
      where: { runId_nodeKey: { runId: meanRunId, nodeKey: 'map' } },
      select: { output: true },
    });
    const out = map!.output as { resultsPath?: string; resultsCount?: number };
    expect(out.resultsCount).toBe(columnCount);
    expect(typeof out.resultsPath).toBe('string');

    // the array lives in the file, not on the map node's output → cap-safe for any N
    expect(JSON.stringify(map!.output).length).toBeLessThan(2000);

    const elements = JSON.parse(fs.readFileSync(out.resultsPath!, 'utf8')) as Array<{ rows: number }>;
    expect(elements).toHaveLength(columnCount);
    expect(elements.every((e) => e.rows === rowsPerChild)).toBe(true);
  });

  it('mean mode computes a real aggregate over all children', async () => {
    const parent = await ctx.db.prisma.run.findUnique({
      where: { id: meanRunId },
      select: { status: true },
    });
    expect(parent?.status).toBe('SUCCEEDED');

    const reduce = await ctx.db.prisma.nodeRun.findUnique({
      where: { runId_nodeKey: { runId: meanRunId, nodeKey: 'reduce' } },
    });
    expect(reduce?.status).toBe('SUCCEEDED');
    expect(reduce!.output).toMatchObject({
      mode: 'mean',
      field: 'rows',
      value: rowsPerChild, // mean of a constant across every child
      count: columnCount,
    });

    // downstream ran after the reduce
    const merge = await ctx.db.prisma.nodeRun.findUnique({
      where: { runId_nodeKey: { runId: meanRunId, nodeKey: 'merge' } },
      select: { status: true, attempt: true, startedAt: true },
    });
    expect(merge).toMatchObject({ status: 'SUCCEEDED', attempt: 0 });
    expect(merge!.startedAt!.getTime()).toBeGreaterThanOrEqual(reduce!.finishedAt!.getTime() - 2000);
  });

  it('concat mode flattens the children into one by-reference array', async () => {
    const parent = await ctx.db.prisma.run.findUnique({
      where: { id: concatRunId },
      select: { status: true },
    });
    expect(parent?.status).toBe('SUCCEEDED');

    const reduce = await ctx.db.prisma.nodeRun.findUnique({
      where: { runId_nodeKey: { runId: concatRunId, nodeKey: 'reduce' } },
      select: { status: true, output: true },
    });
    expect(reduce?.status).toBe('SUCCEEDED');
    const out = reduce!.output as { mode: string; count: number; resultsPath: string };
    expect(out.mode).toBe('concat');
    expect(out.count).toBe(columnCount);

    const flat = JSON.parse(fs.readFileSync(out.resultsPath, 'utf8')) as unknown[];
    expect(flat).toHaveLength(columnCount);
  });
});
