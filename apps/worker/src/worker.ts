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
import { tryTransitionNodeRun, setNodeRunError } from '@dag/db';
import { connection, publishRunEvent, isRunCancelled } from '@dag/queue';
import type { JobPayload } from '@dag/contracts';
import { env } from './env';
import { logger } from './logger';
import { executors } from './executors';
import type { ExecutorContext } from './executor-types';
import { PythonCancelledError } from './python-bridge';
import { exponentialJitter } from './backoff';
import { createArtifactStore } from './artifact-store';

/** One store for the whole process (roadmap C1.1/C1.2) — cheap to construct, but no need to redo it per job. */
const artifactStore = createArtifactStore(env);

/** How often a running worker polls the run's hard-cancel flag (roadmap B4). */
const CANCEL_POLL_MS = 5_000;

// Concurrency per queue type (overridable via env)
const CONCURRENCY = {
  io: parseInt(process.env['IO_CONCURRENCY'] ?? '8', 10),
  cpu: parseInt(process.env['CPU_CONCURRENCY'] ?? '4', 10),
  gpu: parseInt(process.env['GPU_CONCURRENCY'] ?? '1', 10),
};

// ─── Job processor ────────────────────────────────────────────────────────────

async function processJob(job: Job<JobPayload>): Promise<unknown> {
  const { runId, nodeKey, nodeRunId, type, config, input, attempt } = job.data;
  const workerId = process.env['WORKER_ID'] ?? `worker-${process.pid}`;

  logger.info({ runId, nodeKey, type, attempt }, 'Worker: processing job');

  const publishNodeCancelled = () =>
    publishRunEvent(runId, {
      runId,
      nodeKey,
      type: 'NODE_CANCELLED',
      payload: { reason: 'run cancelled' },
      ts: Date.now(),
    }).catch(() => {});

  // 0. Hard-cancel pre-check (roadmap B4): the run may have been cancelled
  //    while this job sat in the queue — don't even start the executor.
  if (await isRunCancelled(runId)) {
    await tryTransitionNodeRun(nodeRunId, 'QUEUED', 'CANCELLED', { finishedAt: new Date() });
    await publishNodeCancelled();
    logger.info({ runId, nodeKey }, 'Worker: run cancelled before start — skipping');
    return null;
  }

  // 1. Transition NodeRun QUEUED → RUNNING
  //    Use the conditional update pattern — if we lose the race (e.g. this job
  //    was re-delivered after a stall), the update returns false and we bail.
  const claimed = await tryTransitionNodeRun(nodeRunId, 'QUEUED', 'RUNNING', {
    workerId,
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
    payload: { workerId },
    ts: Date.now(),
  }).catch((err) => logger.warn({ err }, 'Failed to publish NODE_RUNNING'));

  // 3. Cancellation watch — poll the run's hard-cancel flag and abort the
  //    executor (which forwards the signal to its Python child) on a hit.
  const controller = new AbortController();
  const cancelPoll = setInterval(() => {
    void isRunCancelled(runId).then((cancelled) => {
      if (cancelled && !controller.signal.aborted) {
        logger.info({ runId, nodeKey }, 'Worker: run cancelled — aborting executor');
        controller.abort();
      }
    });
  }, CANCEL_POLL_MS);

  // 4. Build executor context
  const ctx: ExecutorContext = {
    runId,
    nodeKey,
    input: (input ?? {}) as Record<string, unknown>,
    config: (config ?? {}) as Record<string, unknown>,
    artifactDir: env.ARTIFACT_DIR,
    store: artifactStore,
    job,
    signal: controller.signal,
    onLog: (line: string) => {
      publishRunEvent(runId, {
        runId,
        nodeKey,
        type: 'NODE_LOG',
        payload: { line, ts: Date.now() },
        ts: Date.now(),
      }).catch(() => {});
    },
  };

  // 5. Dispatch to the registered executor
  const executor = executors[type];
  if (!executor) {
    // Unknown type — should never happen due to the registry compile-time check,
    // but guard defensively at runtime.
    clearInterval(cancelPoll);
    throw new UnrecoverableError(`No executor registered for node type: ${type}`);
  }

  try {
    const output = await executor(ctx);
    logger.info({ runId, nodeKey }, 'Worker: job completed successfully');
    return output;
  } catch (err) {
    // A cancelled run: land the NodeRun on CANCELLED (the cancel path likely
    // already did via updateMany) and return normally so BullMQ does NOT retry.
    if (controller.signal.aborted || err instanceof PythonCancelledError || (await isRunCancelled(runId))) {
      await tryTransitionNodeRun(nodeRunId, 'RUNNING', 'CANCELLED', { finishedAt: new Date() });
      await publishNodeCancelled();
      logger.info({ runId, nodeKey }, 'Worker: executor stopped by cancellation');
      return null;
    }

    // ── Retry policy (roadmap B5) ─────────────────────────────────────────
    const message = err instanceof Error ? err.message : String(err);
    const taxonomy: 'retryable' | 'unrecoverable' =
      err instanceof UnrecoverableError ? 'unrecoverable' : 'retryable';
    const maxAttempts = job.opts.attempts ?? 1;
    const thisAttempt = job.attemptsMade + 1;
    const errorInfo = { message, taxonomy, attempt: thisAttempt, maxAttempts };
    // BullMQ retries only a retryable error with attempts left.
    const willRetry = taxonomy === 'retryable' && thisAttempt < maxAttempts;

    if (willRetry) {
      // Hand the row back to QUEUED so the NEXT BullMQ attempt re-executes it.
      // Without this, the retry's QUEUED→RUNNING claim fails, the job returns
      // null "successfully", and a transient failure becomes a phantom success.
      await tryTransitionNodeRun(nodeRunId, 'RUNNING', 'QUEUED', {
        error: errorInfo,
        startedAt: null,
        finishedAt: null,
      });
      await publishRunEvent(runId, {
        runId,
        nodeKey,
        type: 'NODE_QUEUED',
        payload: { retry: true, attempt: thisAttempt, maxAttempts, taxonomy },
        ts: Date.now(),
      }).catch(() => {});
      logger.warn({ runId, nodeKey, attempt: thisAttempt, maxAttempts }, 'Worker: attempt failed — retrying');
    } else {
      // Terminal: stamp the taxonomy-rich error so `onNodeFailed` keeps it
      // instead of overwriting with the bare BullMQ failedReason.
      await setNodeRunError(nodeRunId, errorInfo);
    }
    throw err;
  } finally {
    clearInterval(cancelPoll);
  }
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

    worker.on('completed', (job) => {
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
