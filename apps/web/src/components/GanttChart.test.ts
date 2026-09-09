import { describe, it, expect } from 'vitest';
import { nodeDurationMs, nodeDurations } from './GanttChart';
import type { NodeRunSummary } from '../api/client';

function nr(partial: Partial<NodeRunSummary>): NodeRunSummary {
  return {
    id: 'x',
    nodeKey: 'n',
    status: 'SUCCEEDED',
    attempt: 1,
    startedAt: null,
    finishedAt: null,
    workerId: null,
    output: null,
    error: null,
    ...partial,
  };
}

describe('GanttChart timing helpers (D3 run comparison)', () => {
  it('nodeDurationMs returns null for a node that never started', () => {
    expect(nodeDurationMs(nr({ startedAt: null }))).toBeNull();
  });

  it('nodeDurationMs is the finished-minus-started span', () => {
    const d = nodeDurationMs(
      nr({ startedAt: '2026-09-10T10:00:00.000Z', finishedAt: '2026-09-10T10:00:05.000Z' }),
    );
    expect(d).toBe(5000);
  });

  it('nodeDurationMs never goes negative on clock skew', () => {
    const d = nodeDurationMs(
      nr({ startedAt: '2026-09-10T10:00:05.000Z', finishedAt: '2026-09-10T10:00:00.000Z' }),
    );
    expect(d).toBe(0);
  });

  it('nodeDurations maps only the nodes that have timing', () => {
    const map = nodeDurations([
      nr({ nodeKey: 'a', startedAt: '2026-09-10T10:00:00.000Z', finishedAt: '2026-09-10T10:00:02.000Z' }),
      nr({ nodeKey: 'b', startedAt: '2026-09-10T10:00:00.000Z', finishedAt: '2026-09-10T10:00:10.000Z' }),
      nr({ nodeKey: 'c', startedAt: null }),
    ]);
    expect(map).toEqual({ a: 2000, b: 10000 });
    expect('c' in map).toBe(false);
  });
});
