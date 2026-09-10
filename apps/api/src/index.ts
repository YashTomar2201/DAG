/**
 * API server entry point.
 *
 * Responsibilities:
 *   1. Parse + validate env vars (crashes loudly on misconfiguration).
 *   2. Create the Express app.
 *   3. Bind to the configured port and log the address.
 *   4. Handle graceful shutdown on SIGTERM / SIGINT.
 */
import './tracing'; // must be first — patches http/express/pg/ioredis before they load
import { env } from './env';
import { createApp } from './app';
import { logger } from './logger';
import { prisma } from '@dag/db';
import { stopTracing } from '@dag/otel';
import { startQueueEventListeners } from './worker-events';
import { startSchedulerWorker } from './scheduler-worker';
import { sweepBlockedDispatches } from './services/orchestrator.service';
import { beginShutdown } from './lifecycle';

// How long to keep serving after SIGTERM before closing the HTTP server, so
// Kubernetes has time to observe /health/ready flip to 503 and pull this pod
// from the Service's endpoints (roadmap C3.2). Below the manifest's
// terminationGracePeriodSeconds.
const READINESS_DRAIN_MS = 5_000;

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

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return; // a second SIGTERM shouldn't restart the sequence
  shuttingDown = true;

  logger.info({ signal }, 'Shutdown signal received — failing readiness, then draining');
  // 1. Fail /health/ready NOW so Kubernetes stops routing new traffic here.
  beginShutdown();
  closeQueueEvents();
  clearInterval(blockedSweepTimer);
  await closeScheduler().catch((err) => logger.error({ err }, 'Error closing scheduler worker'));

  // 2. Give the endpoint-removal a moment to propagate before we stop
  //    accepting connections (avoids a race where the LB still sends here).
  await new Promise((r) => setTimeout(r, READINESS_DRAIN_MS));

  // 3. Stop accepting new connections; let in-flight requests finish.
  server.close(async () => {
    await prisma.$disconnect();
    await stopTracing();
    logger.info('Server closed, Prisma disconnected');
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
