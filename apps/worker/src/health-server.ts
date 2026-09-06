/**
 * A tiny dependency-free HTTP server so Kubernetes can probe a worker pod
 * (roadmap C3.2). Workers have no Express app — this is `node:http` and
 * nothing else.
 *
 *   /health/live   — process is up. Never checks Redis/Postgres: a liveness
 *                    failure restarts the pod, and a transient dependency
 *                    blip must not cause a restart loop.
 *   /health/ready  — can this worker actually process a job right now?
 *                    Redis (BullMQ's connection) AND Postgres both reachable,
 *                    and not mid-shutdown. A readiness failure only tells the
 *                    operator/PDB the pod isn't serving; it triggers no restart.
 */
import { createServer, type Server } from 'node:http';
import type { Redis } from 'ioredis';
import { prisma } from '@dag/db';
import { logger } from './logger';

let shuttingDown = false;

/** Called from the SIGTERM handler so readiness fails before the drain begins. */
export function markWorkerShuttingDown(): void {
  shuttingDown = true;
}

// A dependency check must fail fast: `@dag/queue`'s connection is
// `maxRetriesPerRequest: null` (BullMQ needs it), so a bare ping() queues
// forever while Redis is down instead of rejecting.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

export function startHealthServer(port: number, connection: Redis): Server | null {
  if (!port) return null;

  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/health/live' || url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (url === '/health/ready') {
      void (async () => {
        if (shuttingDown) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'shutting_down' }));
          return;
        }
        const checks = { postgres: false, redis: false };
        try {
          await withTimeout(prisma.$queryRaw`SELECT 1`, 2000);
          checks.postgres = true;
        } catch (err) {
          logger.warn({ err }, 'worker readiness: postgres check failed');
        }
        try {
          checks.redis = (await withTimeout(connection.ping(), 2000)) === 'PONG';
        } catch (err) {
          logger.warn({ err }, 'worker readiness: redis check failed');
        }
        const ok = checks.postgres && checks.redis;
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: ok ? 'ready' : 'not_ready', checks }));
      })();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => logger.info({ port }, 'Worker health server listening'));
  return server;
}
