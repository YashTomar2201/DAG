import Redis from 'ioredis';

// Allow overriding via env var, default to local docker-compose redis
const REDIS_URL = process.env['REDIS_URL'] || 'redis://localhost:6379';

/**
 * Standard Redis connection for BullMQ.
 * BullMQ requires maxRetriesPerRequest: null for blocking commands (like BRPOPLPUSH).
 */
export const connection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

/**
 * Separate connection for Pub/Sub.
 * A Redis connection in subscriber mode cannot issue normal commands.
 */
export const pubsub = new Redis(REDIS_URL, {
  lazyConnect: true,
});
