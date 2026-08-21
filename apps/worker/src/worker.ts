/**
 * Worker process factory.
 *
 * Creates one BullMQ `Worker` per queue (io, cpu, gpu).
 * Each worker:
 *   1. Transitions the NodeRun to RUNNING (DB + pub/sub event).
 *   2. Dispatches to the correct executor via the registry.
 *   3. On success: returns the output (the control plane's QueueEvents listener
 *      in apps/api will call onNodeSucceeded).
 *   4. On failure: throws (BullMQ will call the failed handler in apps/api).
 *
 * Graceful shutdown on SIGTERM:
 *   - Calls worker.close() which stops accepting new jobs but lets
 *     in-flight jobs complete (or release their lock if they time out).
 */

import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { prisma, findNodeRun, tryTransitionNodeRun } from '@dag/db';
import { connection, publishRunEvent, releaseConcurrencySlot } from '@dag/queue';
import type { JobPayload } from '@dag/contracts';
import { env } from './env';
import { logger } from './logger';
import { executors } from './executors';
import type { ExecutorContext } from './executor-types';
import { exponentialJitter } from './backoff';

// Concurrency per queue type (overridable via env)
const CONCURRENCY = {
  io: parseInt(process.env['IO_CONCURRENCY'] ?? '8', 10),
  cpu: parseInt(process.env['CPU_CONCURRENCY'] ?? '4', 10),
  gpu: parseInt(process.env['GPU_CONCURRENCY'] ?? '1', 10),
};

// ─── Job processor ────────────────────────────────────────────────────────────

async function processJob(job: Job<JobPayload>): Promise<unknown> {
  const { runId, nodeKey, nodeRunId, type, config, input, attempt } = job.data;

  logger.info({ runId, nodeKey, type, attempt }, 'Worker: processing job');

  // 1. Transition NodeRun QUEUED → RUNNING
  //    Use the conditional update pattern — if we lose the race (e.g. this job
  //    was re-delivered after a stall), the update returns false and we bail.
  const claimed = await tryTransitionNodeRun(nodeRunId, 'QUEUED', 'RUNNING', {
    workerId: process.env['WORKER_ID'] ?? `worker-${process.pid}`,
    startedAt: new Date(),
  });

  if (!claimed) {
    // Another worker already claimed this job (stale re-delivery)
    logger.warn({ runId, nodeKey, nodeRunId }, 'Worker: job already claimed, skipping');
    return null;
  }

  // 2. Publish NODE_RUNNING event for real-time UI
  await publishRunEvent(runId, {
    runId,
    nodeKey,
    type: 'NODE_RUNNING',
    payload: { workerId: process.env['WORKER_ID'] ?? `worker-${process.pid}` },
    ts: Date.now(),
  }).catch((err) => logger.warn({ err }, 'Failed to publish NODE_RUNNING'));

  // 3. Build executor context
  const ctx: ExecutorContext = {
    runId,
    nodeKey,
    input: (input ?? {}) as Record<string, unknown>,
    config: (config ?? {}) as Record<string, unknown>,
    artifactDir: env.ARTIFACT_DIR,
    job,
    onLog: (line: string) => {
      // Publish log lines as NODE_LOG events (buffering is handled by SSE layer in Phase 10)
      publishRunEvent(runId, {
        runId,
        nodeKey,
        type: 'NODE_LOG',
        payload: { line, ts: Date.now() },
        ts: Date.now(),
      }).catch(() => {});
    },
  };

  // 4. Dispatch to the registered executor
  const executor = executors[type];
  if (!executor) {
    // Unknown type — should never happen due to the registry compile-time check,
    // but guard defensively at runtime.
    throw new UnrecoverableError(`No executor registered for node type: ${type}`);
  }

  const output = await executor(ctx);
  logger.info({ runId, nodeKey }, 'Worker: job completed successfully');
  return output;
}

// ─── Worker factory ───────────────────────────────────────────────────────────

export function createWorkers(): Worker[] {
  const queues = ['io', 'cpu', 'gpu'] as const;
  const workers: Worker[] = [];

  for (const queueName of queues) {
    const concurrency = CONCURRENCY[queueName];
    const worker = new Worker<JobPayload>(queueName, processJob, {
      connection,
      concurrency,
      lockDuration: 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 3,
      settings: {
        backoffStrategy: exponentialJitter,
      },
    });

    worker.on('completed', (job, result) => {
      logger.info({ jobId: job.id, queue: queueName }, 'Job completed');
    });

    worker.on('failed', (job, err) => {
      logger.error(
        { jobId: job?.id, queue: queueName, err: err.message },
        'Job failed',
      );
    });

    worker.on('error', (err) => {
      logger.error({ err }, `Worker error on queue: ${queueName}`);
    });

    workers.push(worker);
    logger.info({ queue: queueName, concurrency }, 'Worker started');
  }

  return workers;
}
