import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { workflowRouter } from './routes/workflow.routes';
import { runRouter } from './routes/run.routes';
import { scheduleRouter } from './routes/schedule.routes';
import { triggerRouter } from './routes/trigger.routes';
import { errorHandler } from './middleware/errorHandler';
import { registry, renderMetrics } from './metrics';

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

  // ── Health check (no auth, used by Docker healthchecks) ───────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // ── Prometheus-style metrics (Phase 12) ────────────────────────────────────
  // See metrics.ts for what each series means and why it's computed per-scrape.
  app.get('/metrics', async (_req, res, next) => {
    try {
      res.set('Content-Type', registry.contentType);
      res.send(await renderMetrics());
    } catch (err) {
      next(err);
    }
  });

  // ── API routes ────────────────────────────────────────────────────────────
  app.use('/workflows', workflowRouter);
  app.use('/runs', runRouter);
  // Schedules (B2) and triggers own absolute paths (/workflows/:id/schedules,
  // /schedules/:id, /workflows/:id/triggers, /triggers/:id, /triggers/:token),
  // so they mount at the root rather than under a shared prefix.
  app.use(scheduleRouter);
  app.use(triggerRouter);

  // ── Central error handler — MUST be registered after all routes ───────────
  app.use(errorHandler);

  return app;
}
