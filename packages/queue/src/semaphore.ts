/**
 * Per-run concurrency semaphore.
 *
 * Problem this solves:
 *   A graph with 100 parallel nodes would, without any limit, enqueue all
 *   100 jobs simultaneously. If the cluster has 10 workers with concurrency 4,
 *   that's 40 simultaneous workers all hammering the same upstream endpoints.
 *   One enormous fan-out can monopolise the entire cluster, starving all other
 *   runs from getting any worker capacity.
 *
 * Solution — three-layer concurrency control:
 *   Layer 1: Per-worker `concurrency` option (set in worker.ts). Controls how
 *            many jobs one worker process handles in parallel.
 *   Layer 2: Per-run semaphore (this file). Controls how many nodes from a
 *            SINGLE run can be inflight simultaneously across ALL workers.
 *   Layer 3: Queue-level rate limit on `queue:io` (configured in queues.ts).
 *            Controls the rate of external data-source calls across the system.
 *
 * Implementation:
 *   Redis SETNX (set-if-not-exists) is used to acquire a "slot" for each
 *   dispatched node. Before dispatching, we check how many slots are already
 *   held. If at the limit, dispatch is deferred — the orchestrator will retry
 *   when a slot is freed.
 *
 *   Key: `run:{runId}:slots`   Type: Redis SET   Members: nodeKeys in-flight
 */

import type { Redis } from 'ioredis';

const DEFAULT_MAX_SLOTS = 10;

/**
 * Attempts to acquire a concurrency slot for `nodeKey` within `runId`.
 *
 * Returns `true` if acquired (caller may dispatch), `false` if the run is
 * already at maximum parallelism (caller should skip or re-queue).
 *
 * The slot is automatically released by `releaseConcurrencySlot()` after
 * the job completes or fails.
 */
export async function acquireConcurrencySlot(
  redis: Redis,
  runId: string,
  nodeKey: string,
  maxSlots = DEFAULT_MAX_SLOTS,
): Promise<boolean> {
  const key = `run:${runId}:slots`;

  // Atomic Lua script: check cardinality, add if below limit.
  // Returns 1 if slot was acquired, 0 if at limit.
  const script = `
    local key = KEYS[1]
    local member = ARGV[1]
    local limit = tonumber(ARGV[2])
    local current = redis.call('SCARD', key)
    if current < limit then
      redis.call('SADD', key, member)
      -- TTL as a safety net: slots expire after 24h even if release is missed
      redis.call('EXPIRE', key, 86400)
      return 1
    end
    return 0
  `;

  const result = await redis.eval(script, 1, key, nodeKey, String(maxSlots));
  return result === 1;
}

/**
 * Releases a concurrency slot for `nodeKey` within `runId`.
 * Call this after a job succeeds, fails, or is skipped.
 */
export async function releaseConcurrencySlot(
  redis: Redis,
  runId: string,
  nodeKey: string,
): Promise<void> {
  const key = `run:${runId}:slots`;
  await redis.srem(key, nodeKey);
}

/**
 * Returns the number of currently held slots for a run.
 * Useful for observability and testing.
 */
export async function getActiveSlotCount(redis: Redis, runId: string): Promise<number> {
  const key = `run:${runId}:slots`;
  return redis.scard(key);
}
