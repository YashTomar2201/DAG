/**
 * graphSlice — edge-condition round-trip and the B1.2 `updateEdgeCondition`
 * action. Runs against the real Zustand store via `getState()` (no React).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useGraphStore } from './graphSlice';
import type { Graph } from '@dag/contracts';

const TWO_NODE_GRAPH = {
  nodes: [
    { key: 'a', label: 'A', type: 'data.source', config: {}, position: { x: 0, y: 0 } },
    { key: 'b', label: 'B', type: 'model.evaluate', config: {}, position: { x: 200, y: 0 } },
  ],
  edges: [{ from: 'a', to: 'b' }],
} as unknown as Graph;

function load(graph: Graph) {
  useGraphStore
    .getState()
    .fromGraph(graph, { workflowId: 'w1', versionId: 'v1', name: 'Test' });
}

/** First edge id in the store — throws (fails the test) if there is none. */
function edge0Id(): string {
  const e = useGraphStore.getState().edges[0];
  if (!e) throw new Error('no edges in store');
  return e.id;
}

/** First edge of a serialised graph. */
function firstEdge(g: Graph) {
  const e = g.edges[0];
  if (!e) throw new Error('serialised graph has no edges');
  return e;
}

beforeEach(() => {
  useGraphStore.getState().newWorkflow();
});

describe('edge conditions (B1.2)', () => {
  it('toGraph() omits condition for a plain edge', () => {
    load(TWO_NODE_GRAPH);
    expect(firstEdge(useGraphStore.getState().toGraph())).toEqual({ from: 'a', to: 'b' });
  });

  it('updateEdgeCondition attaches a condition, coerced and serialised by toGraph()', () => {
    load(TWO_NODE_GRAPH);

    useGraphStore.getState().updateEdgeCondition(edge0Id(), {
      left: '  {{ nodes.a.output.accuracy }}  ',
      op: 'gt',
      right: '0.9',
    });

    expect(useGraphStore.getState().isDirty).toBe(true);
    expect(firstEdge(useGraphStore.getState().toGraph())).toEqual({
      from: 'a',
      to: 'b',
      condition: { left: '{{ nodes.a.output.accuracy }}', op: 'gt', right: 0.9 },
    });
  });

  it('survives a fromGraph → toGraph round-trip', () => {
    const withCond = {
      ...TWO_NODE_GRAPH,
      edges: [
        { from: 'a', to: 'b', condition: { left: '{{ nodes.a.output.ok }}', op: 'eq', right: true } },
      ],
    } as unknown as Graph;

    load(withCond);
    const loaded = useGraphStore.getState().edges[0];
    expect(loaded && (loaded.data as { condition?: unknown }).condition).toEqual({
      left: '{{ nodes.a.output.ok }}',
      op: 'eq',
      right: true,
    });

    expect(firstEdge(useGraphStore.getState().toGraph()).condition).toEqual({
      left: '{{ nodes.a.output.ok }}',
      op: 'eq',
      right: true,
    });
  });

  it('updateEdgeCondition(id, null) removes the condition', () => {
    load(TWO_NODE_GRAPH);
    const id = edge0Id();
    useGraphStore.getState().updateEdgeCondition(id, { left: 'x', op: 'eq', right: '1' });
    useGraphStore.getState().updateEdgeCondition(id, null);

    expect(firstEdge(useGraphStore.getState().toGraph())).toEqual({ from: 'a', to: 'b' });
  });

  it('splits an `in` operator right-hand side into a typed array', () => {
    load(TWO_NODE_GRAPH);
    useGraphStore.getState().updateEdgeCondition(edge0Id(), {
      left: '{{ nodes.a.output.tag }}',
      op: 'in',
      right: 'alpha, 2, beta',
    });

    expect(firstEdge(useGraphStore.getState().toGraph()).condition).toEqual({
      left: '{{ nodes.a.output.tag }}',
      op: 'in',
      right: ['alpha', 2, 'beta'],
    });
  });

  it('is a no-op while viewing a read-only historical version', () => {
    load(TWO_NODE_GRAPH);
    const id = edge0Id();
    useGraphStore.setState({ isReadOnly: true, isDirty: false });

    useGraphStore.getState().updateEdgeCondition(id, { left: 'x', op: 'eq', right: '1' });

    expect(useGraphStore.getState().isDirty).toBe(false);
    expect(firstEdge(useGraphStore.getState().toGraph())).toEqual({ from: 'a', to: 'b' });
  });
});
