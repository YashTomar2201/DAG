import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { randomUUID } from 'crypto';
import { logger } from '../logger';
import {
  CycleError,
  NotFoundError,
  ValidationError,
  ConflictError,
  UnauthorizedError,
} from '../errors';

/**
 * Central error handler — the single place that maps domain errors to HTTP responses.
 *
 * Mapping:
 *   ZodError       → 400  (malformed request body / params)
 *   ValidationError→ 400  (semantic validation failure)
 *   CycleError     → 422  (graph is structurally invalid — cycle detected)
 *   NotFoundError  → 404
 *   ConflictError  → 409
 *   UnauthorizedError → 401  (bad/missing API key, metrics token, or webhook HMAC signature)
 *   everything else→ 500  (unexpected; include correlation id for log lookup)
 *
 * Express identifies this as an error handler because it has 4 parameters.
 * It MUST be registered last, after all routes.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const correlationId = randomUUID();

  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation failed',
      issues: err.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  if (err instanceof CycleError) {
    res.status(422).json({
      error: 'Graph contains a cycle',
      cyclePath: err.path,
    });
    return;
  }

  if (err instanceof NotFoundError) {
    res.status(404).json({
      error: err.message,
      resource: err.resource,
      id: err.id,
    });
    return;
  }

  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }

  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }

  if (err instanceof UnauthorizedError) {
    res.status(401).json({ error: err.message });
    return;
  }

  // Unknown error — log with full details, return sanitised response
  logger.error({ err, correlationId, url: req.url, method: req.method }, 'Unhandled error');
  res.status(500).json({
    error: 'Internal server error',
    correlationId,
  });
}
