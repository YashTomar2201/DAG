import pino from 'pino';
import { env } from './env';

/**
 * Root Pino logger for the API process.
 *
 * Usage:
 *   import { logger } from './logger';
 *   const childLogger = logger.child({ runId, nodeKey });
 *   childLogger.info({ event: 'node_dispatched' }, 'Node dispatched to queue');
 *
 * Rules (from PROJECT_GUIDE.md §8):
 *   - Structured logging only — no bare console.log in service/route code.
 *   - Every log line inside a run MUST carry `runId`.
 *   - Use child loggers: `logger.child({ runId })` to avoid repeating the field.
 */
export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport:
    env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
