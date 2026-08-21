import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import type { RunEvent } from '@dag/contracts';
import { connection } from './redis';

// Allow overriding via env var, default to local docker-compose redis
const REDIS_URL = process.env['REDIS_URL'] || 'redis://localhost:6379';

/**
 * Publishes an event for a specific run on the shared control-plane connection.
 *
 * Publishing is fine on the standard connection because Redis publishing does
 * not put the connection into subscriber mode.
 */
export async function publishRunEvent(
  runId: string,
  event: RunEvent
): Promise<void> {
  const channel = `run:${runId}:events`;
  await connection.publish(channel, JSON.stringify(event));
}

/**
 * Subscribes to events for a specific run.
 *
 * A Redis connection that has called SUBSCRIBE is locked into subscriber mode
 * and can no longer issue standard commands. To support many concurrent
 * subscribers (e.g. one SSE client per browser tab) without coupling them, we
 * spawn a **dedicated subscriber connection per call**. Subscriber connections
 * are cheap on Redis; the alternative — sharing one connection across
 * subscribers — leaks channels and crosses message streams.
 *
 * Returns a cleanup function that unsubscribes and closes the connection.
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export async function subscribeToRun(
  runId: string,
  cb: (event: RunEvent) => void
): Promise<() => void> {
  const channel = `run:${runId}:events`;

  // Dedicated connection — never shared, never used for anything else.
  const sub: RedisType = new Redis(REDIS_URL, { lazyConnect: true });
  await sub.subscribe(channel);

  const onMessage = (ch: string, message: string) => {
    if (ch !== channel) return;
    try {
      const event = JSON.parse(message) as RunEvent;
      cb(event);
    } catch {
      // Ignore malformed messages — a publisher bug must not crash the subscriber.
    }
  };
  sub.on('message', onMessage);

  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    sub.off('message', onMessage);
    try {
      await sub.unsubscribe(channel);
    } catch {
      // Connection may already be torn down; nothing to do.
    }
    try {
      await sub.quit();
    } catch {
      sub.disconnect();
    }
  };
}
