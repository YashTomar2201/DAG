import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { workflowRouter } from './routes/workflow.routes';
import { runRouter } from './routes/run.routes';
import { scheduleRouter } from './routes/schedule.routes';
import { triggerRouter } from './routes/trigger.routes';
import { errorHandler } from './middleware/errorHandler';
import { requireApiKey } from './middleware/auth';
import { requireMetricsToken } from './middleware/metricsAuth';
import { registry, renderMetrics } from './metrics';
import { prisma } from '@dag/db';
import { connection } from '@dag/queue';
import { isShuttingDown } from './lifecycle';
import { logger } from './logger';

/**
 * Creates and returns the configured Express application.
 *
 * Exported as a factory function (not a singleton) so integration tests can
 * create fresh app instances without sharing global state.
 *
 * Middleware order (matters for Express):
 *   1. cors()              — allow browser cross-origin requests (web @ :5173 → api @ :3001)
 *   2. express.json()      — parse request body
 *   3. Routes              — handle requests
 *   4. errorHandler        — catch errors from routes/services (must be LAST)
 */
export function createApp(): Express {
  const app = express();

  // ── CORS — allow the Vite dev server and the nginx-served build to call the API ──
  // In production, tighten ALLOWED_ORIGIN to the real frontend domain.
  const ALLOWED_ORIGIN = process.env.CORS_ORIGIN ?? '*';
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Last-Event-ID');
    // SSE streams need this so EventSource can read named events cross-origin
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ── Webhook raw body ─────────────────────────────────────────────────────
  // The trigger webhook verifies an HMAC over the EXACT request bytes, so it
  // must see the raw Buffer — capture it here, before express.json, and only
  // for this one route+method (express.raw calls next(), so the request still
  // falls through to the trigger router). express.json then no-ops because
  // express.raw has already marked the body as read.
  app.post('/triggers/:token', express.raw({ type: () => true, limit: '1mb' }));

  // ── Body parsing ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: '1mb' }));

  // ── Health probes (no auth — Kubernetes / Docker healthchecks) ────────────
  // roadmap C3.2:
  //   /health/live  — is the process up? (livenessProbe — a failure restarts
  //                   the pod, so it must NOT depend on Postgres/Redis: a
  //                   transient DB blip shouldn't trigger a restart loop.)
  //   /health/ready — can it serve traffic RIGHT NOW? (readinessProbe —
  //                   Postgres AND Redis both reachable, and not mid-shutdown.
  //                   A failure only pulls the pod from the Service, no restart.)
  //   /health       — kept as an alias of /health/live for the existing
  //                   docker-compose healthcheck and older manifests.
  const live = (_req: Request, res: Response) => res.json({ status: 'ok' });
  app.get('/health', live);
  app.get('/health/live', live);

  // A dependency check must FAIL FAST, not hang: `@dag/queue`'s `connection`
  // is configured `maxRetriesPerRequest: null` (BullMQ needs that for its
  // blocking commands), so a bare `connection.ping()` queues forever while
  // Redis is down instead of rejecting. Race every check against a short
  // timeout so a dead dependency yields a prompt 503, not a stuck request.
  const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
    ]);

  app.get('/health/ready', async (_req: Request, res: Response) => {
    if (isShuttingDown()) {
      res.status(503).json({ status: 'shutting_down' });
      return;
    }
    const checks: Record<string, boolean> = { postgres: false, redis: false };
    try {
      await withTimeout(prisma.$queryRaw`SELECT 1`, 2000);
      checks.postgres = true;
    } catch (err) {
      logger.warn({ err }, 'readiness: postgres check failed');
    }
    try {
      const pong = await withTimeout(connection.ping(), 2000);
      checks.redis = pong === 'PONG';
    } catch (err) {
      logger.warn({ err }, 'readiness: redis check failed');
    }
    const ok = checks.postgres && checks.redis;
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', checks });
  });

  // ── Prometheus-style metrics (Phase 12) ────────────────────────────────────
  // See metrics.ts for what each series means and why it's computed per-scrape.
  // Protected by a static shared secret (roadmap A3), not an API key — see
  // middleware/metricsAuth.ts for why a scraper needs a different shape of
  // credential than a tenant.
  app.get('/metrics', requireMetricsToken, async (_req, res, next) => {
    try {
      res.set('Content-Type', registry.contentType);
      res.send(await renderMetrics());
    } catch (err) {
      next(err);
    }
  });

  // ── API routes (roadmap A3: every one of these requires a verified API key) ──
  // `requireApiKey` sets `req.tenantId`; every route/service downstream reads
  // that instead of a client-supplied `tenantId` field. `workflowRouter` mounts
  // under a path prefix with no exceptions, so `app.use(path, requireApiKey, ...)`
  // scopes the check correctly. `runRouter`, `scheduleRouter`, and
  // `triggerRouter` each have at least one route that can't require a normal
  // API key (the SSE stream — `EventSource` can't send custom headers — and
  // the public webhook receiver), so they apply `requireApiKey` to their own
  // routes internally instead of at the mount point here.
  app.use('/workflows', requireApiKey, workflowRouter);
  app.use('/runs', runRouter);
  app.use(scheduleRouter);
  app.use(triggerRouter);

  // ── Central error handler — MUST be registered after all routes ───────────
  app.use(errorHandler);

  return app;
}
