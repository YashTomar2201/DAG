/**
 * Per-tenant concurrency quota (roadmap C2.3).
 *
 * Problem this solves: without it, one tenant with a 1000-node fan-out can
 * saturate every worker in the cluster, starving every other tenant's runs of
 * capacity — the per-run semaphore in `semaphore.ts` bounds a single run's
 * own parallelism, but does nothing once that run belongs to a tenant running
 * many runs at once, or many tenants share the cluster.
 *
 * Shape copied directly from `semaphore.ts`'s per-run slot pattern, keyed by
 * tenant instead of by run: `{tenantId}:concurrency:slots` (a Redis SET of
 * in-flight NodeRun ids), bounded by `Tenant.concurrencyLimit`
 * (`packages/db`). `dispatchNode` (`apps/api/src/services/orchestrator.service.ts`)
 * acquires a slot before claiming a node; over quota, the node is left
 * PENDING and its `{runId, nodeKey}` is recorded in
 * `{tenantId}:concurrency:blocked` (a Redis SET) instead. Two things drain
 * that set: a slot release immediately pops and retries one blocked entry
 * (the common case), and a periodic sweep (`sweepBlockedDispatches` in
 * `orchestrator.service.ts`) mops up the case the roadmap explicitly calls
 * out — "no parent will complete again" to trigger a natural retry, e.g. the
 * tenant's other in-flight nodes are themselves long-running rather than
 * finishing in a burst.
 *
 * Known limitation, inherited from `semaphore.ts`'s own design: the whole-key
 * `EXPIRE` is a backstop against a fully abandoned tenant (no dispatch calls
 * refreshing the TTL at all), not a per-member TTL — a slot leaked by a path
 * that skips `onNodeSucceeded`/`onNodeFailed` (a hard-cancelled or skipped
 * node) stays held until the whole key next goes quiet for 24h. Acceptable
 * for the same reason `semaphore.ts` accepted it: closing it properly needs a
 * per-member-expiry structure (a sorted set keyed by acquire time, swept
 * separately) that is real added complexity for a should-be-rare leak path,
 * not a roadmap C2.3 requirement.
 */

import { connection } from './redis';

const DEFAULT_TENANT_MAX_SLOTS = 20;
const SLOTS_TTL_SECONDS = 24 * 3600;
const BLOCKED_TTL_SECONDS = 24 * 3600;

function slotsKey(tenantId: string): string {
  return `${tenantId}:concurrency:slots`;
}

function blockedKey(tenantId: string): string {
  return `${tenantId}:concurrency:blocked`;
}

/**
 * Attempts to acquire a concurrency slot for `nodeRunId` within `tenantId`.
 * Returns `true` if acquired (caller may dispatch), `false` if the tenant is
 * already at its quota (caller should defer — see `queueBlockedDispatch`).
 */
export async function acquireTenantSlot(
  tenantId: string,
  nodeRunId: string,
  limit = DEFAULT_TENANT_MAX_SLOTS,
): Promise<boolean> {
  const key = slotsKey(tenantId);
  const script = `
    local key = KEYS[1]
    local member = ARGV[1]
    local limit = tonumber(ARGV[2])
    local current = redis.call('SCARD', key)
    if current < limit then
      redis.call('SADD', key, member)
      redis.call('EXPIRE', key, ${SLOTS_TTL_SECONDS})
      return 1
    end
    return 0
  `;
  const result = await connection.eval(script, 1, key, nodeRunId, String(limit));
  return result === 1;
}

/** Releases a tenant concurrency slot. Call once a NodeRun reaches a terminal state. */
export async function releaseTenantSlot(tenantId: string, nodeRunId: string): Promise<void> {
  await connection.srem(slotsKey(tenantId), nodeRunId);
}

/** Number of slots currently held by a tenant. Observability + used by the periodic sweep. */
export async function getTenantActiveSlotCount(tenantId: string): Promise<number> {
  return connection.scard(slotsKey(tenantId));
}

/** Records a dispatch that was deferred because the tenant was over quota. */
export async function queueBlockedDispatch(tenantId: string, runId: string, nodeKey: string): Promise<void> {
  const key = blockedKey(tenantId);
  const p = connection.pipeline();
  p.sadd(key, `${runId}:${nodeKey}`);
  p.expire(key, BLOCKED_TTL_SECONDS);
  await p.exec();
}

/** Pops (removes and returns) one blocked dispatch for a tenant, or null if none are queued. */
export async function popBlockedDispatch(
  tenantId: string,
): Promise<{ runId: string; nodeKey: string } | null> {
  const member = await connection.spop(blockedKey(tenantId));
  if (!member) return null;
  const idx = member.indexOf(':');
  if (idx < 0) return null; // malformed — drop it rather than loop forever
  return { runId: member.slice(0, idx), nodeKey: member.slice(idx + 1) };
}

/**
 * Every tenant id with at least one blocked dispatch waiting. Used by the
 * periodic sweep to find tenants worth checking without a global registry —
 * `SCAN` (not `KEYS`) so this never blocks Redis even with many tenants.
 */
export async function listBlockedTenantIds(): Promise<string[]> {
  const tenantIds: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await connection.scan(cursor, 'MATCH', '*:concurrency:blocked', 'COUNT', 100);
    cursor = next;
    for (const key of keys) {
      const suffix = ':concurrency:blocked';
      if (key.endsWith(suffix)) tenantIds.push(key.slice(0, -suffix.length));
    }
  } while (cursor !== '0');
  return tenantIds;
}
