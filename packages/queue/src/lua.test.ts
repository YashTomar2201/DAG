/**
 * Phase 5 — Redis atomicity tests
 *
 * Acceptance check: a test seeds in-degrees for the diamond graph, fires 2 concurrent decrements of
 * node `d` from two clients, and asserts **exactly one** returns `1`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connection, seedInDegrees, decrementInDegree } from './index';

// ─── Guard: skip if no real Redis is configured ─────────────────────────────
// We need a real Redis instance to test Lua script atomicity under concurrent load.
const HAS_REDIS = Boolean(process.env['REDIS_URL']);

// The diamond graph:
//   a
//  / \
// b   c
//  \ /
//   d
const DIAMOND_EDGES = [
  { from: 'a', to: 'b' },
  { from: 'a', to: 'c' },
  { from: 'b', to: 'd' },
  { from: 'c', to: 'd' },
];

describe.skipIf(!HAS_REDIS)('Phase 5 — Redis Lua atomicity (requires real Redis)', () => {
  const runId = `test-run-${Date.now()}`;

  beforeAll(async () => {
    // Seed the graph in-degrees
    // In the diamond graph: b=1, c=1, d=2
    await seedInDegrees(runId, DIAMOND_EDGES);
  });

  afterAll(async () => {
    // Cleanup
    await connection.del(`run:${runId}:indegree`);
    await connection.del(`run:${runId}:dispatched`);
    connection.disconnect();
  });

  it('correctly initializes the in-degrees', async () => {
    const bDegree = await connection.hget(`run:${runId}:indegree`, 'b');
    const cDegree = await connection.hget(`run:${runId}:indegree`, 'c');
    const dDegree = await connection.hget(`run:${runId}:indegree`, 'd');

    expect(bDegree).toBe('1');
    expect(cDegree).toBe('1');
    expect(dDegree).toBe('2');
  });

  it('decrementing a node with >1 remaining returns false', async () => {
    // First parent of 'd' completes
    const shouldDispatch = await decrementInDegree(runId, 'd');
    expect(shouldDispatch).toBe(false); // still 1 remaining parent
    
    const dDegree = await connection.hget(`run:${runId}:indegree`, 'd');
    expect(dDegree).toBe('1');
  });

  it('decrementing the final parent returns true (owner of dispatch)', async () => {
    // Second parent of 'd' completes
    const shouldDispatch = await decrementInDegree(runId, 'd');
    expect(shouldDispatch).toBe(true); // 0 remaining parents -> you dispatch
    
    const dDegree = await connection.hget(`run:${runId}:indegree`, 'd');
    expect(dDegree).toBe('0');
  });

  it('a delayed concurrent decrement after it hits 0 returns false (SADD guard)', async () => {
    // What if a third caller comes in somehow (race condition upstream)?
    // The SADD dispatch guard should return false.
    const shouldDispatch = await decrementInDegree(runId, 'd');
    expect(shouldDispatch).toBe(false);
  });

  // Acceptance Check: The exact double-dispatch race condition
  it('prevents double dispatch when two workers finish concurrently', async () => {
    const concurrentRunId = `test-concurrent-${Date.now()}`;
    await seedInDegrees(concurrentRunId, DIAMOND_EDGES);

    // One parent finishes normally, leaving 1 remaining for 'd'
    await decrementInDegree(concurrentRunId, 'd');

    // Now 'd' has 1 remaining parent.
    // Simulating the race: 'b' and 'c' finish on different workers at the EXACT same ms.
    // They both fire decrementInDegree(concurrentRunId, 'd').
    // Only ONE should ever get true.
    const results = await Promise.all([
      decrementInDegree(concurrentRunId, 'd'),
      decrementInDegree(concurrentRunId, 'd'),
      decrementInDegree(concurrentRunId, 'd'), // Let's fire 3 just to be sure
    ]);

    // Count how many got "true" (meaning they should dispatch the child)
    const trueCount = results.filter((r) => r === true).length;
    
    // Core guarantee: exactly one worker gets the right to dispatch 'd'
    expect(trueCount).toBe(1);

    // Cleanup
    await connection.del(`run:${concurrentRunId}:indegree`);
    await connection.del(`run:${concurrentRunId}:dispatched`);
  });
});
