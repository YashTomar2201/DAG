/**
 * Worker logger — identical pattern to apps/api/src/logger.ts.
 * Pino with JSON output in production, pretty-print in dev.
 */

import pino from 'pino';
import { env } from './env';

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  ...(env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});
