/**
 * API server entry point.
 *
 * Responsibilities:
 *   1. Parse + validate env vars (crashes loudly on misconfiguration).
 *   2. Create the Express app.
 *   3. Bind to the configured port and log the address.
 *   4. Handle graceful shutdown on SIGTERM / SIGINT.
 */
import { env } from './env';
import { createApp } from './app';
import { logger } from './logger';
import { prisma } from '@dag/db';
import { startQueueEventListeners } from './worker-events';
import { startSchedulerWorker } from './scheduler-worker';
import { sweepBlockedDispatches } from './services/orchestrator.service';

const app = createApp();

const server = app.listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT, nodeEnv: env.NODE_ENV }, 'API server started');
});

const closeQueueEvents = startQueueEventListeners();
const closeScheduler = startSchedulerWorker();

// Roadmap C2.3 — periodic backstop for dispatches deferred by a tenant's
// concurrency quota. Not started from `createApp()` (same reasoning as the
// scheduler worker): integration tests call `createApp()` directly and a
// standing timer would keep the test process alive / fire against
// Testcontainers state after teardown.
const BLOCKED_SWEEP_INTERVAL_MS = 15_000;
const blockedSweepTimer = setInterval(() => {
  sweepBlockedDispatches().catch((err) => logger.error({ err }, 'Blocked-dispatch sweep failed'));
}, BLOCKED_SWEEP_INTERVAL_MS);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Allow in-flight requests to complete before closing the DB connection pool.

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutdown signal received — draining connections');
  closeQueueEvents();
  clearInterval(blockedSweepTimer);
  await closeScheduler().catch((err) => logger.error({ err }, 'Error closing scheduler worker'));
  server.close(async () => {
    await prisma.$disconnect();
    logger.info('Server closed, Prisma disconnected');
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
