/**
 * B3.2 — Integration: dynamic fan-out (Testcontainers).
 *
 * Graph:  split (data.source) ── map (flow.map) ── merge (data.source)
 *         + a detached `work` (data.source) node = the per-element subgraph
 *
 * `map.overSource = {{ nodes.split.output.columns }}` — the real titanic
 * header, ~12 entries — so one child run of `work` executes per column.
 *
 * Asserts the three B3.2 "done when" criteria:
 *   - N child runs execute in parallel (>1 distinct workerId)
 *   - the downstream `merge` node runs exactly once, after every child
 *   - replaying the spawn does not create duplicate children
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { seedWorkflowVersion, cleanupWorkflow, waitUntil, tenantScopedPrisma } from './fixtures';
import type { Graph } from '@dag/contracts';

function fanOutGraph(): Graph {
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
      { key: 'merge', type: 'data.source', label: 'Merge', position: { x: 400, y: 0 }, config: {} },
      // Subgraph node — no edges in the parent graph.
      { key: 'work', type: 'data.source', label: 'Work', position: { x: 200, y: 150 }, config: {} },
    ],
    edges: [
      { from: 'split', to: 'map' },
      { from: 'map', to: 'merge' },
    ],
  } as Graph;
}

describe('B3.2 — dynamic fan-out', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let stopQueueEvents: () => void;
  let tenantId: string;
  let workflowId: string;
  let versionId: string;
  let runId: string;
  let columnCount = 0;
  let db: ReturnType<typeof tenantScopedPrisma>;

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();
    stopQueueEvents = ctx.workerEvents.startQueueEventListeners();

    const seeded = await seedWorkflowVersion(ctx.db, fanOutGraph(), 'b32');
    tenantId = seeded.tenantId;
    workflowId = seeded.workflowId;
    versionId = seeded.versionId;
    db = tenantScopedPrisma(ctx.db, tenantId);

    const run = await ctx.orchestrator.startRun(versionId);
    runId = run.id;

    await waitUntil(
      async () => {
        const r = await db.run.findUnique({ where: { id: runId }, select: { status: true } });
        return r?.status === 'SUCCEEDED' || r?.status === 'FAILED';
      },
      { timeoutMs: 120_000 },
    );

    const splitNr = await db.nodeRun.findUnique({
      where: { runId_nodeKey: { runId, nodeKey: 'split' } },
      select: { output: true },
    });
    columnCount = ((splitNr?.output as { columns?: unknown[] })?.columns ?? []).length;
  }, 180_000);

  afterAll(async () => {
    stopQueueEvents?.();
    await db.runEvent.deleteMany({
      where: { run: { OR: [{ id: runId }, { parentRunId: runId }] } },
    });
    await db.nodeRun.deleteMany({
      where: { run: { OR: [{ id: runId }, { parentRunId: runId }] } },
    });
    await db.run.deleteMany({ where: { parentRunId: runId } });
    await cleanupWorkflow(ctx.db, tenantId, workflowId);
    await teardownTestEnv(ctx);
  });

  it('spawns one child run per source element, all SUCCEEDED and fanout-tagged', async () => {
    expect(columnCount).toBeGreaterThan(5);

    const children = await db.run.findMany({
      where: { parentRunId: runId },
      orderBy: { fanOutIndex: 'asc' },
    });
    expect(children).toHaveLength(columnCount);
    expect(children.every((c) => c.status === 'SUCCEEDED')).toBe(true);
    expect(children.every((c) => c.triggeredBy === 'fanout')).toBe(true);
    expect(children.map((c) => c.fanOutIndex)).toEqual([...Array(columnCount).keys()]);
  });

  it('runs the children in parallel across workers', async () => {
    const childIds = (
      await db.run.findMany({ where: { parentRunId: runId }, select: { id: true } })
    ).map((c) => c.id);
    const workNrs = await db.nodeRun.findMany({
      where: { runId: { in: childIds }, nodeKey: 'work' },
      select: { workerId: true },
    });
    const workers = new Set(workNrs.map((n) => n.workerId).filter(Boolean));
    expect(workers.size).toBeGreaterThanOrEqual(2); // global-setup spawns 2 workers
  });

  it('injects the per-element value into each child as the map node output', async () => {
    const childIds = (
      await db.run.findMany({ where: { parentRunId: runId }, select: { id: true } })
    ).map((c) => c.id);
    const seeds = await db.nodeRun.findMany({
      where: { runId: { in: childIds }, nodeKey: 'map' },
      select: { status: true, output: true },
    });
    expect(seeds).toHaveLength(columnCount);
    expect(seeds.every((s) => s.status === 'SUCCEEDED')).toBe(true);
    const indices = seeds
      .map((s) => (s.output as { index?: number }).index)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(indices).toEqual([...Array(columnCount).keys()]);
    expect(seeds.every((s) => typeof (s.output as { item?: unknown }).item === 'string')).toBe(true);
  });

  it('runs the downstream node exactly once, after every child, with a fan-out summary', async () => {
    const parent = await db.run.findUnique({ where: { id: runId }, select: { status: true } });
    expect(parent?.status).toBe('SUCCEEDED');

    const merge = await db.nodeRun.findUnique({
      where: { runId_nodeKey: { runId, nodeKey: 'merge' } },
    });
    expect(merge?.status).toBe('SUCCEEDED');
    expect(merge?.attempt).toBe(0); // ran once, no retries

    const children = await db.run.findMany({
      where: { parentRunId: runId },
      select: { finishedAt: true },
    });
    const lastChild = Math.max(...children.map((c) => c.finishedAt!.getTime()));
    expect(merge!.startedAt!.getTime()).toBeGreaterThanOrEqual(lastChild - 2000);

    const map = await db.nodeRun.findUnique({
      where: { runId_nodeKey: { runId, nodeKey: 'map' } },
      select: { output: true },
    });
    expect((map!.output as { fanOut?: unknown }).fanOut).toMatchObject({
      childCount: columnCount,
      succeeded: columnCount,
      failed: 0,
    });

    // subgraph node has NO NodeRun in the parent run
    const parentWork = await db.nodeRun.findUnique({
      where: { runId_nodeKey: { runId, nodeKey: 'work' } },
    });
    expect(parentWork).toBeNull();
  });

  it('emits RUN_SPAWNED once and RUN_CHILD_COMPLETED per child (B3.5)', async () => {
    const events = await db.runEvent.findMany({
      where: { runId, type: { in: ['RUN_SPAWNED', 'RUN_CHILD_COMPLETED'] } },
      orderBy: { id: 'asc' },
    });
    const spawned = events.filter((e) => e.type === 'RUN_SPAWNED');
    const childDone = events.filter((e) => e.type === 'RUN_CHILD_COMPLETED');

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.payload).toMatchObject({ mapNodeKey: 'map', total: columnCount });

    expect(childDone).toHaveLength(columnCount);
    // the last one carries the fully-tallied summary
    expect(childDone.at(-1)!.payload).toMatchObject({
      mapNodeKey: 'map',
      total: columnCount,
      succeeded: columnCount,
      failed: 0,
    });
    // fanOutIndex is present on every child-completed event
    expect(childDone.every((e) => typeof (e.payload as { fanOutIndex?: unknown }).fanOutIndex === 'number')).toBe(true);
  });

  it('replaying the spawn creates no duplicate children', async () => {
    const before = await db.run.count({ where: { parentRunId: runId } });

    const nodeRunMap = await ctx.db.getNodeRunMap(runId, tenantId);
    await ctx.orchestrator.spawnFanOut(runId, 'map', tenantId, fanOutGraph(), versionId, nodeRunMap);

    const after = await db.run.count({ where: { parentRunId: runId } });
    expect(after).toBe(before);

    // and the downstream node still ran exactly once
    const merge = await db.nodeRun.findUnique({
      where: { runId_nodeKey: { runId, nodeKey: 'merge' } },
      select: { attempt: true, status: true },
    });
    expect(merge).toMatchObject({ attempt: 0, status: 'SUCCEEDED' });
  });
});
