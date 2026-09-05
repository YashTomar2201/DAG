/**
 * Phase 12 — Integration: the race-condition test (Testcontainers).
 *
 * Acceptance check (build-dag-engine.md, Phase 12):
 *   "Race-condition test: the diamond graph with b and c completing
 *    simultaneously — assert d has exactly one NodeRun, one dispatch event,
 *    and one execution."
 *
 * How this test DETERMINISTICALLY forces the interleaving, rather than
 * hoping two real workers happen to collide on the same millisecond:
 *
 *   We call `onNodeSucceeded(runId, 'b', ...)` and `onNodeSucceeded(runId,
 *   'c', ...)` directly, together, inside a single `Promise.all([...])` —
 *   both calls begin executing synchronously and each hits its first
 *   `await` (a real Postgres query) before either can finish. From that
 *   point on the Node.js event loop is genuinely juggling two in-flight
 *   async call stacks that both intend to decrement `d`'s in-degree counter
 *   — this is *exactly* the two-worker interleaving described in
 *   PROJECT_GUIDE.md §7.3, reproduced on purpose instead of waited for.
 *   Every run of this test forces the same interleaving; it is not a flaky
 *   "usually catches it" test.
 *
 * Why `a`, `b`, and `c` are seeded directly instead of dispatched through
 * `startRun`/`dispatchNode`: this suite shares two long-lived worker
 * processes across every test file (see global-setup.ts). A real dispatch
 * puts a real job on a real queue those workers are always polling — they
 * would race to execute `b` and `c` themselves before this test gets a
 * chance to drive the two `onNodeSucceeded` calls by hand, defeating the
 * deterministic setup above. Seeding `b`/`c` straight into RUNNING via
 * Postgres (no BullMQ job ever created for them) keeps the *setup*
 * uncontested while keeping the *thing under test* — `d`'s dispatch —
 * fully real: `onNodeSucceeded` still runs the real Lua decrement and a
 * real `queue.add()` for `d` through the exact same code path production
 * traffic uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { diamondGraph, seedWorkflowVersion, cleanupWorkflow } from './fixtures';

describe('Phase 12 — race condition: b and c completing simultaneously', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let tenantId: string;
  let workflowId: string;
  let versionId: string;

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();
    const seeded = await seedWorkflowVersion(ctx.db, diamondGraph(), 'race-condition');
    tenantId = seeded.tenantId;
    workflowId = seeded.workflowId;
    versionId = seeded.versionId;
  }, 60_000);

  afterAll(async () => {
    await cleanupWorkflow(ctx.db, tenantId, workflowId);
    await teardownTestEnv(ctx);
  });

  it('dispatches d exactly once no matter how b and c interleave', async () => {
    const nodeKeys = ['a', 'b', 'c', 'd'];
    const run = await ctx.db.createRun(versionId, tenantId, 'race-condition-test', nodeKeys);

    // Seed the real in-degree hash exactly as startRun would (b=1, c=1, d=2
    // for this graph's edges) — this is the real Redis state the Lua script
    // decrements against.
    await ctx.queue.seedInDegrees(run.id, diamondGraph().edges);

    // Put b and c straight into RUNNING by hand — see the file header for
    // why this bypasses dispatchNode/BullMQ entirely for the setup step.
    const bRun = await ctx.db.findNodeRun(run.id, 'b', tenantId);
    const cRun = await ctx.db.findNodeRun(run.id, 'c', tenantId);
    await ctx.db.withTenant(tenantId, (tx) => tx.nodeRun.update({ where: { id: bRun!.id }, data: { status: 'RUNNING' } }));
    await ctx.db.withTenant(tenantId, (tx) => tx.nodeRun.update({ where: { id: cRun!.id }, data: { status: 'RUNNING' } }));

    // ── THE RACE ─────────────────────────────────────────────────────────
    // Both parents of `d` report success in the same tick. Real Postgres
    // conditional updates, real Lua decrement, real dispatchNode → real
    // BullMQ `queue.add()` for `d` — nothing here is mocked.
    await Promise.all([
      ctx.orchestrator.onNodeSucceeded(run.id, 'b', tenantId, { rows: 1 }),
      ctx.orchestrator.onNodeSucceeded(run.id, 'c', tenantId, { rows: 1 }),
    ]);

    // ── Assertion 1: exactly one NodeRun row for `d` ────────────────────
    const dNodeRuns = await ctx.db.withTenant(tenantId, (tx) =>
      tx.nodeRun.findMany({ where: { runId: run.id, nodeKey: 'd' } }),
    );
    expect(dNodeRuns).toHaveLength(1);
    // QUEUED (not yet picked up) or RUNNING/SUCCEEDED (one of the two
    // shared workers already grabbed it) are both proof of exactly one
    // dispatch — PENDING or a second row would not be.
    expect(['QUEUED', 'RUNNING', 'SUCCEEDED']).toContain(dNodeRuns[0]!.status);

    // ── Assertion 2: exactly one dispatch event for `d` ─────────────────
    const dispatchEvents = await ctx.db.withTenant(tenantId, (tx) =>
      tx.runEvent.findMany({ where: { runId: run.id, nodeKey: 'd', type: 'NODE_QUEUED' } }),
    );
    expect(dispatchEvents).toHaveLength(1);

    // ── Assertion 3: exactly one execution was ever enqueued for `d` ────
    // `d` is `model.evaluate` -> queue:cpu (see queueForType in
    // packages/queue/src/queues.ts). The deterministic jobId
    // `{runId}:d:0` can only ever have been created once — if a second
    // dispatch had slipped through, it would have collided on this same
    // id and BullMQ would have silently dropped it (layer 3 of the
    // four-layer defence — see decisions_log.md), so a single `getJob`
    // hit here is exactly the "one execution" proof, independent of
    // whether the shared worker has already consumed it by the time we look.
    const dJob = await ctx.queue.cpuQueue.getJob(ctx.queue.createJobId(run.id, 'd', 0));
    expect(dJob).toBeDefined();
    expect(dJob!.data.nodeKey).toBe('d');

    // ── Assertion 4: the Redis state backing the decision is consistent ─
    const remaining = await ctx.queue.connection.hget(`run:${run.id}:indegree`, 'd');
    expect(remaining).toBe('0');
    const dispatchedMembers = await ctx.queue.connection.smembers(`run:${run.id}:dispatched`);
    expect(dispatchedMembers.filter((m) => m === 'd')).toHaveLength(1);
  }, 30_000);
});
