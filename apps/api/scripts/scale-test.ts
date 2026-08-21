/**
 * Phase 12 — Scale test (horizontal-scaling proof).
 *
 * Acceptance check (build-dag-engine.md, Phase 12):
 *   "Scale test: 200 concurrent runs of a 10-node graph across 4 worker
 *    processes; record throughput, p95 node latency, and queue depth. Then
 *    run the identical load with 1 worker and chart both — this is the
 *    horizontal-scaling proof for the README."
 *
 * This is a standalone benchmark, not a `pnpm test` suite member — it's
 * meant to be run by a human to produce evidence, the same way a load-test
 * tool is run outside CI. It talks to the SAME local infrastructure
 * `infra/docker-compose.yml` starts (not a throwaway Testcontainers
 * instance): a benchmark result is only meaningful if it's reproducible
 * against the infra a reader can `docker compose up` themselves.
 *
 * What it measures, per pass:
 *   - throughput   = total NodeRuns completed / wall-clock seconds
 *   - p50/p95/p99 node latency = distribution of (finishedAt - startedAt)
 *     across every NodeRun that reached SUCCEEDED
 *   - queue depth  = max and average `queue:cpu` waiting-job count, sampled
 *     every 250ms for the duration of the run
 *
 * Usage:
 *   pnpm --filter @dag/api scale-test                  # 200 runs, passes: 1w then 4w
 *   SCALE_TEST_RUNS=20 pnpm --filter @dag/api scale-test  # smoke test
 *
 * Requires: `docker compose -f infra/docker-compose.yml up -d` already running.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { topologicalSort } from '@dag/graph-core';
import type { Graph } from '@dag/contracts';
import { spawnWorkerProcess, waitForWorkerReady, type SpawnedWorker } from '../src/integration/worker-process';

const REPO_ROOT = path.resolve(__dirname, '../../../');

const RUNS = Number(process.env['SCALE_TEST_RUNS'] ?? 200);
const CPU_CONCURRENCY = Number(process.env['SCALE_TEST_CPU_CONCURRENCY'] ?? 8);
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://dag:dag_secret@localhost:5432/dag_engine';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

// ─── The 10-node scale-test graph ──────────────────────────────────────────
//
//         root
//    /  /  |  \  \    (8-wide fan-out — the max-parallelism tier)
//  b1 b2 b3 b4 ... b8
//    \  \  |  /  /
//         sink
//
// All ten nodes are `pandas.preprocess` / `model.evaluate` — both route to
// `queue:cpu` (see queueForType in packages/queue/src/queues.ts) and both
// execute the real, dependency-free fixture scripts in apps/worker/python/.
// A fan-out/fan-in shape (rather than a straight chain) is deliberate: it
// maximises how many nodes are simultaneously READY across 200 concurrent
// runs, which is what actually stresses queue depth and worker concurrency
// — a 10-node chain would only ever have ~200 nodes ready at once (one per
// run); this shape puts up to 1,600 `branch` nodes in the ready set at once.
function scaleTestGraph(): Graph {
  const branches = Array.from({ length: 8 }, (_, i) => `branch${i + 1}`);
  return {
    nodes: [
      { key: 'root', type: 'pandas.preprocess', label: 'Root', position: { x: 0, y: 0 }, config: { scriptPath: 'preprocess.py' } },
      ...branches.map((key, i) => ({
        key,
        type: 'model.evaluate' as const,
        label: key,
        position: { x: 200, y: i * 60 },
        config: { scriptPath: 'evaluate.py' },
      })),
      { key: 'sink', type: 'pandas.preprocess', label: 'Sink', position: { x: 400, y: 0 }, config: { scriptPath: 'preprocess.py' } },
    ],
    edges: [
      ...branches.map((b) => ({ from: 'root', to: b })),
      ...branches.map((b) => ({ from: b, to: 'sink' })),
    ],
  } as Graph;
}

// Worker process spawning reuses src/integration/worker-process.ts — same
// tsx-direct-binary spawn, same taskkill-based tree kill. See that file for
// why: a plain `proc.kill()` on a `shell:true`-spawned process only signals
// the shell, not the worker it launched — the earlier version of this
// script duplicated a version of spawnWorker() without that fix, and every
// "stopped" worker from every prior run was in fact still alive, still
// holding a Postgres connection. By the 4-worker pass, `max_connections`
// was exhausted before the pass even started. Reusing the fixed helper
// means there is exactly one implementation of "spawn/stop a worker
// process" in the repo, not two that can drift out of sync.

// ─── One benchmark pass ────────────────────────────────────────────────────

interface PassResult {
  workerCount: number;
  runs: number;
  wallClockMs: number;
  nodesCompleted: number;
  throughputNodesPerSec: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxQueueDepth: number;
  avgQueueDepth: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function runPass(workerCount: number): Promise<PassResult> {
  console.log(`\n─── Pass: ${workerCount} worker process(es), ${RUNS} concurrent runs ───`);

  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-scaletest-artifacts-'));

  process.env['DATABASE_URL'] = DATABASE_URL;
  process.env['REDIS_URL'] = REDIS_URL;
  process.env['ARTIFACT_DIR'] = artifactDir;
  process.env['NODE_ENV'] = 'production';
  // This SCRIPT process plays the control-plane role for all `RUNS`
  // concurrent runs at once — every startRun/dispatchNode/onNodeSucceeded
  // call for all 200 runs funnels through this one PrismaClient. That's a
  // much higher concurrent-query load than any single worker (which mostly
  // does one conditional UPDATE per job), so it gets a much larger pool.
  // Workers get client.ts's small default (5) via workerEnv below — see
  // packages/db/src/client.ts for the full "why" and the max_connections
  // budget this is dividing up.
  process.env['DB_POOL_SIZE'] = '30';

  // Dynamic import AFTER env is set — same reasoning as
  // src/integration/test-env.ts: @dag/db and @dag/queue read
  // DATABASE_URL/REDIS_URL from process.env at module-load time.
  const { prisma } = await import('@dag/db');
  const queue = await import('@dag/queue');
  const orchestrator = await import('../src/services/orchestrator.service');
  const workerEvents = await import('../src/worker-events');

  const graph = scaleTestGraph();
  const topoOrder = topologicalSort(graph);
  const tenant = await prisma.tenant.create({ data: { name: `scale-test-${workerCount}w-${Date.now()}` } });
  const workflow = await prisma.workflow.create({ data: { tenantId: tenant.id, name: 'scale-test' } });
  const version = await prisma.workflowVersion.create({
    data: { workflowId: workflow.id, version: 1, graph: graph as unknown as object, topoOrder: topoOrder as unknown as object },
  });

  const workerEnv = {
    DATABASE_URL,
    REDIS_URL,
    ARTIFACT_DIR: artifactDir,
    CPU_CONCURRENCY: String(CPU_CONCURRENCY),
    DB_POOL_SIZE: '5', // small on purpose — do NOT inherit this process's DB_POOL_SIZE=30 above
    NODE_ENV: 'production', // quiet pino output — this is a throughput run, not a debug session
  };
  const workers: SpawnedWorker[] = Array.from({ length: workerCount }, (_, i) =>
    spawnWorkerProcess({ ...workerEnv, WORKER_ID: `scale-${workerCount}w-${i}` }, `scale-${workerCount}w-${i}`),
  );
  await Promise.all(workers.map((w) => waitForWorkerReady(w)));
  const stopQueueEvents = workerEvents.startQueueEventListeners();

  // ── Queue-depth sampler ───────────────────────────────────────────────
  const depthSamples: number[] = [];
  const sampler = setInterval(() => {
    queue.cpuQueue
      .getWaitingCount()
      .then((n) => depthSamples.push(n))
      .catch(() => {});
  }, 250);

  const startedAt = Date.now();
  let runIds: string[] = [];

  // Workers and the queue-depth sampler MUST be torn down even if the wait
  // loop below times out or throws — otherwise a failed pass leaves worker
  // processes running (still holding DB connections) into the NEXT pass,
  // exactly the failure mode that made the first attempt at this benchmark
  // fail outright (see decisions_log.md).
  try {
    // ── Fire all RUNS concurrently ──────────────────────────────────────
    runIds = await Promise.all(
      Array.from({ length: RUNS }, () => orchestrator.startRun(version.id).then((r) => r.id)),
    );

    // ── Wait for every run to reach a terminal state ────────────────────
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('scale test pass timed out')), 20 * 60 * 1000);
      const poll = setInterval(async () => {
        const remaining = await prisma.run.count({
          where: { id: { in: runIds }, status: { in: ['PENDING', 'RUNNING'] } },
        });
        if (remaining === 0) {
          clearInterval(poll);
          clearTimeout(timeout);
          resolve();
        }
      }, 300);
    });
  } finally {
    clearInterval(sampler);
    stopQueueEvents();
    await Promise.all(workers.map((w) => w.stop()));
  }

  const wallClockMs = Date.now() - startedAt;
  const TOTAL_NODES = RUNS * graph.nodes.length;

  // ── Collect latency distribution ─────────────────────────────────────
  const nodeRuns = await prisma.nodeRun.findMany({
    where: { runId: { in: runIds }, status: 'SUCCEEDED' },
    select: { startedAt: true, finishedAt: true },
  });
  const durations = nodeRuns
    .filter((n) => n.startedAt && n.finishedAt)
    .map((n) => n.finishedAt!.getTime() - n.startedAt!.getTime())
    .sort((a, b) => a - b);

  const result: PassResult = {
    workerCount,
    runs: RUNS,
    wallClockMs,
    nodesCompleted: nodeRuns.length,
    throughputNodesPerSec: nodeRuns.length / (wallClockMs / 1000),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxQueueDepth: depthSamples.length ? Math.max(...depthSamples) : 0,
    avgQueueDepth: depthSamples.length ? depthSamples.reduce((a, b) => a + b, 0) / depthSamples.length : 0,
  };

  console.log(
    `  ${nodeRuns.length}/${TOTAL_NODES} nodes completed in ${(wallClockMs / 1000).toFixed(1)}s ` +
      `(${result.throughputNodesPerSec.toFixed(1)} nodes/s), p95=${result.p95Ms}ms, maxQueueDepth=${result.maxQueueDepth}`,
  );

  // Cleanup — DB rows and the artifact dir only. NOT the Redis/Prisma
  // connections: `import('@dag/db')` / `import('@dag/queue')` are cached by
  // Node's module system across calls within this one process, so runPass()
  // for the *next* worker count reuses the exact same `connection` /
  // `prisma` singletons. Closing them here would hand pass 2 a dead
  // connection — that's exactly what happened before this comment existed.
  // The real teardown happens once, in main(), after every pass is done.
  await prisma.runEvent.deleteMany({ where: { runId: { in: runIds } } });
  await prisma.nodeRun.deleteMany({ where: { runId: { in: runIds } } });
  await prisma.run.deleteMany({ where: { id: { in: runIds } } });
  await prisma.workflowVersion.delete({ where: { id: version.id } });
  await prisma.workflow.delete({ where: { id: workflow.id } });
  await prisma.tenant.delete({ where: { id: tenant.id } });
  fs.rmSync(artifactDir, { recursive: true, force: true });

  return result;
}

function renderMarkdownTable(results: PassResult[]): string {
  const header = '| Workers | Runs | Nodes completed | Wall clock | Throughput | p50 | p95 | p99 | Max queue depth | Avg queue depth |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|';
  const rows = results.map(
    (r) =>
      `| ${r.workerCount} | ${r.runs} | ${r.nodesCompleted} | ${(r.wallClockMs / 1000).toFixed(1)}s | ` +
      `${r.throughputNodesPerSec.toFixed(1)} nodes/s | ${r.p50Ms}ms | ${r.p95Ms}ms | ${r.p99Ms}ms | ` +
      `${r.maxQueueDepth} | ${r.avgQueueDepth.toFixed(1)} |`,
  );
  const baseline = results.find((r) => r.workerCount === 1);
  const speedupLines = baseline
    ? results
        .filter((r) => r.workerCount !== 1)
        .map(
          (r) =>
            `- ${r.workerCount} workers vs 1: **${(r.throughputNodesPerSec / baseline.throughputNodesPerSec).toFixed(2)}x** throughput`,
        )
    : [];

  return [
    `# Phase 12 — Scale Test Results`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `Graph: 10-node fan-out/fan-in (1 root -> 8 parallel branches -> 1 sink), ${RUNS} concurrent runs per pass, CPU_CONCURRENCY=${CPU_CONCURRENCY} per worker (held constant across passes so worker COUNT is the only variable).`,
    ``,
    header,
    sep,
    ...rows,
    ``,
    ...speedupLines,
    ``,
    `## How to read this table`,
    ``,
    `- **Throughput** (nodes/s) is the primary horizontal-scaling signal: it should scale roughly with worker count, since \`queue:cpu\`'s waiting jobs are the shared resource every worker process pulls from independently.`,
    `- **p95 node latency** captures tail behaviour, not just the average — a system that's fast on average but has a long tail under load is exactly what queue depth explains (jobs spending longer in \`waiting\` before a worker slot frees up).`,
    `- **Max/avg queue depth** is the direct evidence of backpressure: with 1 worker, ${CPU_CONCURRENCY} concurrency slots must absorb up to ${RUNS * 8} branch nodes becoming ready near-simultaneously (8-wide fan-out x ${RUNS} runs) — expect a deep, slow-draining queue. With 4 workers the same burst is spread across ${CPU_CONCURRENCY * 4} slots, so the queue should drain visibly faster and the p95 should be markedly lower.`,
  ].join('\n');
}

async function main() {
  console.log(`Phase 12 scale test — ${RUNS} runs per pass, CPU_CONCURRENCY=${CPU_CONCURRENCY}`);
  console.log(`DATABASE_URL=${DATABASE_URL}`);
  console.log(`REDIS_URL=${REDIS_URL}`);

  const results: PassResult[] = [];
  results.push(await runPass(1));
  results.push(await runPass(4));

  const md = renderMarkdownTable(results);
  console.log('\n' + md);

  const outDir = path.join(REPO_ROOT, 'benchmarks');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'phase-12-scale-test.md');
  fs.writeFileSync(outPath, md);
  console.log(`\nResults written to ${outPath}`);

  // Real teardown — once, after both passes (see the comment in runPass()).
  const { prisma } = await import('@dag/db');
  const queue = await import('@dag/queue');
  await Promise.allSettled([queue.ioQueue.close(), queue.cpuQueue.close(), queue.gpuQueue.close()]);
  await queue.connection.quit().catch(() => {});
  await prisma.$disconnect();

  process.exit(0);
}

main().catch((err) => {
  console.error('Scale test failed:', err);
  process.exit(1);
});
