/**
 * Exponential backoff with full jitter — the backoff strategy registered on
 * every BullMQ Worker to prevent thundering-herd retries.
 *
 * Why jitter matters:
 *   Standard exponential backoff (2s, 4s, 8s …) is *deterministic*. If 50
 *   `data.source` jobs all fail at the same instant (e.g. a shared upstream
 *   rate-limit window), they all wait exactly 4 s and then hit the same
 *   endpoint at the same millisecond — immediately triggering another
 *   rate-limit. The thundering herd repeats until the backoff cap (32 s).
 *
 *   Full-jitter replaces the fixed wait with `random(0, 2^attempt * baseDelay)`.
 *   Each retrying job picks an independent random point inside an exponentially
 *   growing window. The load is spread across time, giving the external service
 *   room to recover.
 *
 * BullMQ strategy registration:
 *   BullMQ allows custom backoff strategies via
 *   `Worker({ settings: { backoffStrategies: { myStrategy: fn } } })`.
 *   The function receives `(attemptsMade, type, err, job)` and returns the
 *   delay in milliseconds for the NEXT attempt.
 *
 * Reference: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */

/** Base delay for attempt 1 (ms). Doubles each attempt, capped at `CAP_MS`. */
const BASE_MS = 2_000;

/** Hard upper bound on backoff delay. */
const CAP_MS = 30_000;

/**
 * Returns the backoff delay (ms) for the given attempt number.
 *
 * Formula: `min(cap, random(0, base * 2^attempt))`
 *
 * @param attemptsMade  Number of attempts already made (0-indexed on first call)
 */
export function exponentialJitterDelay(attemptsMade: number): number {
  // `attemptsMade` is the number of *completed* attempts, so attempt 1 is the
  // first retry. We clamp the exponent to avoid Infinity for very high counts.
  const exponent = Math.min(attemptsMade, 10); // cap at 2^10 = 1024x
  const ceiling = Math.min(CAP_MS, BASE_MS * Math.pow(2, exponent));
  return Math.floor(Math.random() * ceiling);
}

/**
 * BullMQ backoff strategy factory function.
 * Register this as:
 *   `new Worker('queue', handler, { settings: { backoffStrategies: { exponentialJitter } } })`
 */
export function exponentialJitter(
  attemptsMade: number,
  _type: string | undefined,
  _err: Error | undefined,
  _job: unknown,
): number {
  return exponentialJitterDelay(attemptsMade);
}
