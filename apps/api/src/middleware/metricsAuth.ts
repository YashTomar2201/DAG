/**
 * Roadmap A3 — protects `/metrics` with a static shared secret, not an API
 * key. Prometheus scrapes with one fixed bearer token configured once in its
 * scrape config; it has no concept of "one key per tenant" and metrics
 * aren't tenant data anyway (queue depth, worker counts) — a single
 * `METRICS_TOKEN` is the right shape here, not `requireApiKey`.
 */
import type { Request, Response, NextFunction } from 'express';
import { env } from '../env';
import { UnauthorizedError } from '../errors';

export function requireMetricsToken(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || match[1]!.trim() !== env.METRICS_TOKEN) {
    next(new UnauthorizedError('Missing or invalid metrics token'));
    return;
  }
  next();
}
