/**
 * Worker entry point.
 * Boots the BullMQ workers and handles graceful shutdown.
 */

import { logger } from './logger';
import { createWorkers } from './worker';
import { env } from './env';
import { prisma } from '@dag/db';
import { connection } from '@dag/queue';
import { startHealthServer, markWorkerShuttingDown } from './health-server';

logger.info({ pid: process.pid, nodeEnv: env.NODE_ENV }, 'Worker process starting');

const workers = createWorkers();
const healthServer = startHealthServer(env.WORKER_HEALTH_PORT, connection);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// On SIGTERM: fail readiness, stop accepting new jobs, let in-flight jobs
// finish, disconnect. Kubernetes waits terminationGracePeriodSeconds (set in
// infra/k8s/worker.yaml above the longest node timeout) before SIGKILL, so a
// long training job in flight runs to completion instead of being cut off.
// On SIGINT (Ctrl+C in dev): same.

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal, pid: process.pid }, 'Shutdown signal received — draining workers');
  markWorkerShuttingDown();

  // `worker.close()` stops new job polling; waits for active jobs to finish.
  await Promise.all(workers.map((w) => w.close()));
  healthServer?.close();
  await prisma.$disconnect();
  await connection.quit().catch(() => {});

  logger.info('Workers drained, exiting');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
