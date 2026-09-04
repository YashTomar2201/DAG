/**
 * runSlice — the B3.5 fan-out progress reducer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useRunStore } from './runSlice';

const apply = (type: string, payload: Record<string, unknown>) =>
  useRunStore.getState().applyEvent(type, payload);

beforeEach(() => {
  useRunStore.setState({ fanOut: {}, nodeStatuses: {}, logs: [], runStatus: 'RUNNING' });
});

describe('fan-out progress (B3.5)', () => {
  it('RUN_SPAWNED seeds total with zero progress', () => {
    apply('RUN_SPAWNED', { mapNodeKey: 'map', total: 100 });
    expect(useRunStore.getState().fanOut['map']).toEqual({
      total: 100, succeeded: 0, failed: 0, cancelled: 0, done: 0,
    });
  });

  it('RUN_CHILD_COMPLETED updates the running tallies and derives done', () => {
    apply('RUN_SPAWNED', { mapNodeKey: 'map', total: 10 });
    apply('RUN_CHILD_COMPLETED', { mapNodeKey: 'map', total: 10, succeeded: 3, failed: 1, cancelled: 0 });
    expect(useRunStore.getState().fanOut['map']).toEqual({
      total: 10, succeeded: 3, failed: 1, cancelled: 0, done: 4,
    });

    apply('RUN_CHILD_COMPLETED', { mapNodeKey: 'map', total: 10, succeeded: 7, failed: 2, cancelled: 1 });
    expect(useRunStore.getState().fanOut['map']).toEqual({
      total: 10, succeeded: 7, failed: 2, cancelled: 1, done: 10,
    });
  });

  it('a CHILD_COMPLETED before SPAWNED still records, keeping any known total', () => {
    apply('RUN_CHILD_COMPLETED', { mapNodeKey: 'm2', total: 5, succeeded: 1, failed: 0, cancelled: 0 });
    expect(useRunStore.getState().fanOut['m2']).toMatchObject({ total: 5, succeeded: 1, done: 1 });
  });

  it('tracks two flow.map nodes independently', () => {
    apply('RUN_SPAWNED', { mapNodeKey: 'a', total: 4 });
    apply('RUN_SPAWNED', { mapNodeKey: 'b', total: 8 });
    apply('RUN_CHILD_COMPLETED', { mapNodeKey: 'a', total: 4, succeeded: 4, failed: 0, cancelled: 0 });
    expect(useRunStore.getState().fanOut['a']!.done).toBe(4);
    expect(useRunStore.getState().fanOut['b']!.done).toBe(0);
  });

  it('startListening clears fan-out state', () => {
    apply('RUN_SPAWNED', { mapNodeKey: 'map', total: 3 });
    useRunStore.getState().startListening('run-1', () => {});
    expect(useRunStore.getState().fanOut).toEqual({});
  });
});
