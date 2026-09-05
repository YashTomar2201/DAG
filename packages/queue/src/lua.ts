import { connection } from './redis';

/**
 * Every run-scoped Redis key is namespaced by tenant (roadmap C2.2) —
 * `{tenantId}:run:{runId}:{suffix}` — so two tenants sharing one Redis
 * instance can never collide on or enumerate each other's keys, even though
 * `runId` (a cuid) is already effectively unguessable on its own. This is the
 * broker-layer counterpart to C2.1's Postgres RLS: that closed the DB, this
 * closes Redis.
 */
function tenantRunKey(tenantId: string, runId: string, suffix: string): string {
  return `${tenantId}:run:${runId}:${suffix}`;
}

/**
 * Lua script for atomic in-degree decrement and dispatch gating.
 *
 * KEYS[1] = {tenantId}:run:{runId}:indegree   (hash: nodeKey -> remaining parents)
 * KEYS[2] = {tenantId}:run:{runId}:dispatched (set of already-dispatched nodeKeys)
 * ARGV[1] = childKey
 *
 * Returns 1 if the caller should dispatch this node.
 * Returns 0 otherwise.
 */
const DECREMENT_LUA = `
local remaining = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
if remaining > 0 then return 0 end
if redis.call('SADD', KEYS[2], ARGV[1]) == 0 then return 0 end
return 1
`;

// Define the command on the Redis instance
connection.defineCommand('decrementInDegree', {
  numberOfKeys: 2,
  lua: DECREMENT_LUA,
});

/**
 * Type augmentation for the dynamically defined command
 */
declare module 'ioredis' {
  interface Redis {
    decrementInDegree(
      key1: string,
      key2: string,
      arg1: string
    ): Promise<number>;
  }
}

/**
 * Decrements the in-degree for a child node.
 * Returns true if this worker should dispatch the child, false otherwise.
 */
export async function decrementInDegree(
  runId: string,
  childKey: string,
  tenantId: string
): Promise<boolean> {
  const indegreeKey = tenantRunKey(tenantId, runId, 'indegree');
  const dispatchedKey = tenantRunKey(tenantId, runId, 'dispatched');

  const result = await connection.decrementInDegree(
    indegreeKey,
    dispatchedKey,
    childKey
  );

  return result === 1;
}

/**
 * Seeds the initial in-degree hash for a run using a pipeline.
 * Called exactly once when a run starts.
 *
 * @param runId The ID of the run
 * @param edges List of all edges in the graph
 */
export async function seedInDegrees(
  runId: string,
  edges: { from: string; to: string }[],
  tenantId: string
): Promise<void> {
  const indegreeMap = new Map<string, number>();

  // Count incoming edges for each node
  for (const edge of edges) {
    const current = indegreeMap.get(edge.to) || 0;
    indegreeMap.set(edge.to, current + 1);
  }

  // If there are no edges, we don't need to seed anything
  if (indegreeMap.size === 0) return;

  const indegreeKey = tenantRunKey(tenantId, runId, 'indegree');
  const pipeline = connection.pipeline();

  // Seed the hash with the initial counts
  for (const [nodeKey, count] of indegreeMap.entries()) {
    pipeline.hset(indegreeKey, nodeKey, count);
  }

  // Expiration so run data doesn't accumulate forever
  pipeline.expire(indegreeKey, 7 * 24 * 3600);
  pipeline.expire(tenantRunKey(tenantId, runId, 'dispatched'), 7 * 24 * 3600);

  await pipeline.exec();
}

// ─── Active-parent tracking for conditional edges (B1.1) ─────────────────────
//
// Join semantics: "any active parent" — a child runs if AT LEAST ONE incoming
// edge was active (unconditional, or its condition passed). It is SKIPPED only
// when EVERY incoming edge was inactive.
// `{tenantId}:run:{runId}:activeParents:{childKey}` is a Redis set of the
// parent keys whose edge into `childKey` was active. The
// in-degree hash still decrements for every parent regardless — so a skipped
// branch can never leave a child hanging at in-degree > 0.

const ACTIVE_PARENTS_TTL = 7 * 24 * 3600;

/** Record that `parentKey`'s edge into `childKey` was active. Call BEFORE decrementInDegree. */
export async function markParentActive(
  runId: string,
  childKey: string,
  parentKey: string,
  tenantId: string,
): Promise<void> {
  const key = tenantRunKey(tenantId, runId, `activeParents:${childKey}`);
  const p = connection.pipeline();
  p.sadd(key, parentKey);
  p.expire(key, ACTIVE_PARENTS_TTL);
  await p.exec();
}

/** True if any incoming edge into `childKey` has been marked active. */
export async function hasActiveParent(runId: string, childKey: string, tenantId: string): Promise<boolean> {
  const key = tenantRunKey(tenantId, runId, `activeParents:${childKey}`);
  return (await connection.scard(key)) > 0;
}

// ─── Fan-out join claim (roadmap B3.2) ──────────────────────────────────────
//
// When the last of N fan-out child runs reaches a terminal state, several
// siblings can observe "no children left" at the same instant. Exactly one of
// them must run the join (decrement the downstream node's in-degree, merge the
// summary). `claimFanOutJoin` is that gate: `SADD` returns 1 for the first
// caller and 0 for every other, so only the winner proceeds. Keyed by
// (parentRunId, mapNodeKey) so a graph with two `flow.map` nodes joins each
// independently.

const FANOUT_JOIN_TTL = 7 * 24 * 3600;

/** Returns true for exactly one caller per (parentRunId, mapNodeKey); false for the rest. */
export async function claimFanOutJoin(parentRunId: string, mapNodeKey: string, tenantId: string): Promise<boolean> {
  const key = tenantRunKey(tenantId, parentRunId, 'fanoutJoined');
  const p = connection.pipeline();
  p.sadd(key, mapNodeKey);
  p.expire(key, FANOUT_JOIN_TTL);
  const res = await p.exec();
  // res[0] = [err, saddResult]; sadd returns 1 if the member was added, 0 if it already existed
  return res?.[0]?.[1] === 1;
}

/** Releases a join claim so it can fire again — used when retrying failed children (B3.4). */
export async function clearFanOutJoinClaim(parentRunId: string, mapNodeKey: string, tenantId: string): Promise<void> {
  await connection.srem(tenantRunKey(tenantId, parentRunId, 'fanoutJoined'), mapNodeKey);
}

/**
 * Clears a run's `dispatched` set so its nodes can be re-enqueued (B3.4 retry).
 * Without this, `decrementInDegree`'s `SADD dispatched` would return 0 for a
 * node that ran on the first attempt and the retry would silently never
 * re-dispatch it.
 */
export async function clearDispatched(runId: string, tenantId: string): Promise<void> {
  await connection.del(tenantRunKey(tenantId, runId, 'dispatched'));
}

// ─── Hard cancellation flag (roadmap B4) ────────────────────────────────────
//
// `POST /runs/:id/cancel` removes queued jobs, but a job a worker has ALREADY
// picked up keeps running. This flag is how the worker learns to stop: the
// cancel path sets it, the worker checks it before dispatching an executor and
// again on a poll while the executor runs, and aborts the (Python) child on a
// hit. 24 h TTL so the key can't accumulate.

const CANCEL_FLAG_TTL = 24 * 3600;

/** Marks a run cancelled so in-flight workers bail. Idempotent. */
export async function markRunCancelled(runId: string, tenantId: string): Promise<void> {
  await connection.set(tenantRunKey(tenantId, runId, 'cancelled'), '1', 'EX', CANCEL_FLAG_TTL);
}

/** True once `markRunCancelled` has been called for this run. */
export async function isRunCancelled(runId: string, tenantId: string): Promise<boolean> {
  return (await connection.exists(tenantRunKey(tenantId, runId, 'cancelled'))) === 1;
}
