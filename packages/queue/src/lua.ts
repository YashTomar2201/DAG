import { connection } from './redis';

/**
 * Lua script for atomic in-degree decrement and dispatch gating.
 *
 * KEYS[1] = run:{runId}:indegree   (hash: nodeKey -> remaining parents)
 * KEYS[2] = run:{runId}:dispatched (set of already-dispatched nodeKeys)
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
  childKey: string
): Promise<boolean> {
  const indegreeKey = `run:${runId}:indegree`;
  const dispatchedKey = `run:${runId}:dispatched`;

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
  edges: { from: string; to: string }[]
): Promise<void> {
  const indegreeMap = new Map<string, number>();

  // Count incoming edges for each node
  for (const edge of edges) {
    const current = indegreeMap.get(edge.to) || 0;
    indegreeMap.set(edge.to, current + 1);
  }

  // If there are no edges, we don't need to seed anything
  if (indegreeMap.size === 0) return;

  const indegreeKey = `run:${runId}:indegree`;
  const pipeline = connection.pipeline();

  // Seed the hash with the initial counts
  for (const [nodeKey, count] of indegreeMap.entries()) {
    pipeline.hset(indegreeKey, nodeKey, count);
  }

  // Expiration so run data doesn't accumulate forever
  pipeline.expire(indegreeKey, 7 * 24 * 3600);
  pipeline.expire(`run:${runId}:dispatched`, 7 * 24 * 3600);

  await pipeline.exec();
}
