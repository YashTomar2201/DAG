import express, { type Express } from 'express';
import { workflowRouter } from './routes/workflow.routes';
import { runRouter } from './routes/run.routes';
import { errorHandler } from './middleware/errorHandler';
import { registry, renderMetrics } from './metrics';

/**
 * Creates and returns the configured Express application.
 *
 * Exported as a factory function (not a singleton) so integration tests can
 * create fresh app instances without sharing global state.
 *
 * Middleware order (matters for Express):
 *   1. express.json()      — parse request body
 *   2. Routes              — handle requests
 *   3. errorHandler        — catch errors from routes/services (must be LAST)
 */
export function createApp(): Express {
  const app = express();

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

  // ── Central error handler — MUST be registered after all routes ───────────
  app.use(errorHandler);

  return app;
}
