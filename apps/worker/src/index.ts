/**
 * Worker entry point.
 * Boots the BullMQ workers and handles graceful shutdown.
 */

import { logger } from './logger';
import { createWorkers } from './worker';
import { env } from './env';
import { prisma } from '@dag/db';

logger.info({ pid: process.pid, nodeEnv: env.NODE_ENV }, 'Worker process starting');

const workers = createWorkers();

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// On SIGTERM: stop accepting new jobs, let in-flight jobs complete, disconnect.
// On SIGINT (Ctrl+C in dev): same.

async function shutdown(signal: string) {
  logger.info({ signal, pid: process.pid }, 'Shutdown signal received — draining workers');

  // `worker.close()` stops new job polling; waits for active jobs to finish.
  await Promise.all(workers.map((w) => w.close()));
  await prisma.$disconnect();

  logger.info('Workers drained, exiting');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
