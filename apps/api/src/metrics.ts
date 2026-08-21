/**
 * Phase 12 — Observability: Prometheus-style `/metrics`.
 *
 * Exposes four families of metrics, matching the checkpoint's requirement
 * ("jobs by status, queue depth, node duration histogram, active workers"):
 *
 *   dag_node_runs_by_status{status}  Gauge     — recomputed from Postgres per scrape
 *   dag_runs_by_status{status}       Gauge     — same, at the Run level
 *   dag_queue_depth{queue,state}     Gauge     — BullMQ waiting/active counts per queue
 *   dag_active_workers{queue}        Gauge     — Queue#getWorkers().length per queue
 *   dag_node_duration_seconds{...}   Histogram — observed at transition time (see
 *                                                orchestrator.service.ts)
 *
 * Why prom-client instead of hand-writing the text exposition format:
 * Prometheus's line format (`# HELP`, `# TYPE`, label escaping, histogram
 * `_bucket`/`_sum`/`_count` triples) is easy to get subtly wrong, and
 * `prom-client` is the de-facto standard Node.js client — any Prometheus
 * server, Grafana dashboard, or `promtool` already knows how to consume its
 * output with zero glue code.
 */
import { Registry, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { countNodeRunsByStatus, countRunsByStatus } from '@dag/db';
import { ioQueue, cpuQueue, gpuQueue } from '@dag/queue';

export const registry = new Registry();

// Free process-level metrics (CPU, memory, event loop lag, GC) — useful for
// noticing the API process itself is the bottleneck, not the pipeline.
collectDefaultMetrics({ register: registry, prefix: 'dag_api_process_' });

const nodeRunsByStatus = new Gauge({
  name: 'dag_node_runs_by_status',
  help: 'Current count of NodeRun rows grouped by status. Recomputed from Postgres on every scrape.',
  labelNames: ['status'],
  registers: [registry],
});

const runsByStatus = new Gauge({
  name: 'dag_runs_by_status',
  help: 'Current count of Run rows grouped by status.',
  labelNames: ['status'],
  registers: [registry],
});

const queueDepth = new Gauge({
  name: 'dag_queue_depth',
  help: 'Number of BullMQ jobs per queue, split by state (waiting = not yet picked up, active = currently executing).',
  labelNames: ['queue', 'state'],
  registers: [registry],
});

const activeWorkers = new Gauge({
  name: 'dag_active_workers',
  help: 'Number of worker processes currently connected to each queue (BullMQ Queue#getWorkers()).',
  labelNames: ['queue'],
  registers: [registry],
});

/**
 * Wall-clock duration of one NodeRun execution, from RUNNING to a terminal
 * state. Observed directly by the orchestrator at the moment it records
 * SUCCEEDED or FAILED (see onNodeSucceeded/onNodeFailed in
 * orchestrator.service.ts) — a histogram cannot be reconstructed after the
 * fact from a scrape-time query the way the Gauges above can, because the
 * DB doesn't retain a time series of past durations, only the latest state.
 */
export const nodeDurationSeconds = new Histogram({
  name: 'dag_node_duration_seconds',
  help: 'Duration of a NodeRun execution (RUNNING -> terminal), in seconds.',
  labelNames: ['nodeType', 'outcome'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1800],
  registers: [registry],
});

const QUEUES = { io: ioQueue, cpu: cpuQueue, gpu: gpuQueue } as const;

/**
 * Refreshes every Gauge from live sources (Postgres + Redis/BullMQ) and
 * returns the Prometheus text-exposition-format body for `GET /metrics`.
 *
 * Running these queries per-scrape (rather than on a background interval)
 * keeps the snapshot always current and costs only a handful of
 * index-backed queries — cheap enough for a scrape interval of seconds, not
 * minutes.
 */
export async function renderMetrics(): Promise<string> {
  const [nodeStatusCounts, runStatusCounts] = await Promise.all([
    countNodeRunsByStatus(),
    countRunsByStatus(),
  ]);

  nodeRunsByStatus.reset();
  for (const [status, count] of Object.entries(nodeStatusCounts)) {
    nodeRunsByStatus.set({ status }, count);
  }

  runsByStatus.reset();
  for (const [status, count] of Object.entries(runStatusCounts)) {
    runsByStatus.set({ status }, count);
  }

  queueDepth.reset();
  activeWorkers.reset();

  await Promise.all(
    Object.entries(QUEUES).map(async ([name, queue]) => {
      const [waiting, active, workers] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getWorkers(),
      ]);
      queueDepth.set({ queue: name, state: 'waiting' }, waiting);
      queueDepth.set({ queue: name, state: 'active' }, active);
      activeWorkers.set({ queue: name }, workers.length);
    }),
  );

  return registry.metrics();
}
