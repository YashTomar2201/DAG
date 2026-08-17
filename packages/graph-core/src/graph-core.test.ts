import { describe, it, expect } from 'vitest';
import type { Graph, NodeDef, EdgeDef } from '@dag/contracts';
import { detectCycle } from './cycle';
import { topologicalSort } from './topo';
import { buildAdjacencyMap } from './adjacency';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeNode(key: string): NodeDef {
  return {
    key,
    type: 'pandas.preprocess', // arbitrary valid type
    label: key.toUpperCase(),
    position: { x: 0, y: 0 },
    config: { scriptPath: 'preprocess.py' },
  };
}

function makeEdge(from: string, to: string): EdgeDef {
  return { from, to };
}

// ─── Adjacency Map Tests ─────────────────────────────────────────────────────

describe('buildAdjacencyMap', () => {
  it('correctly maps out-edges and in-degrees', () => {
    const graph: Graph = {
      nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
      edges: [makeEdge('a', 'b'), makeEdge('a', 'c'), makeEdge('b', 'c')],
    };
    
    const { adj, inDegree } = buildAdjacencyMap(graph);
    
    expect(adj.get('a')).toEqual(['b', 'c']);
    expect(adj.get('b')).toEqual(['c']);
    expect(adj.get('c')).toEqual([]);
    
    expect(inDegree.get('a')).toBe(0);
    expect(inDegree.get('b')).toBe(1);
    expect(inDegree.get('c')).toBe(2);
  });

  it('handles disconnected/island nodes', () => {
    const graph: Graph = {
      nodes: [makeNode('a'), makeNode('b')],
      edges: [],
    };
    
    const { adj, inDegree } = buildAdjacencyMap(graph);
    
    expect(adj.get('a')).toEqual([]);
    expect(adj.get('b')).toEqual([]);
    expect(inDegree.get('a')).toBe(0);
    expect(inDegree.get('b')).toBe(0);
  });
});

// ─── Cycle Detection Tests ───────────────────────────────────────────────────

describe('detectCycle', () => {
  it('returns false for a linear graph', () => {
    const graph: Graph = {
      nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
      edges: [makeEdge('a', 'b'), makeEdge('b', 'c')],
    };
    expect(detectCycle(graph).hasCycle).toBe(false);
  });

  it('returns false for a diamond graph', () => {
    // a -> b, a -> c, b -> d, c -> d
    const graph: Graph = {
      nodes: [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')],
      edges: [
        makeEdge('a', 'b'),
        makeEdge('a', 'c'),
        makeEdge('b', 'd'),
        makeEdge('c', 'd'),
      ],
    };
    expect(detectCycle(graph).hasCycle).toBe(false);
  });

  it('returns true for a direct cycle (a -> b -> a)', () => {
    const graph: Graph = {
      nodes: [makeNode('a'), makeNode('b')],
      edges: [makeEdge('a', 'b'), makeEdge('b', 'a')],
    };
    const res = detectCycle(graph);
    expect(res.hasCycle).toBe(true);
    // Cycle path could be a->b->a or b->a->b depending on start node
    expect(res.path?.length).toBe(3);
    expect(res.path![0]).toEqual(res.path![2]);
  });

  it('returns true for an indirect cycle (a -> b -> c -> a)', () => {
    const graph: Graph = {
      nodes: [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')],
      edges: [
        makeEdge('d', 'a'), // d is outside the cycle
        makeEdge('a', 'b'),
        makeEdge('b', 'c'),
        makeEdge('c', 'a'),
      ],
    };
    const res = detectCycle(graph);
    expect(res.hasCycle).toBe(true);
    expect(res.path).toBeDefined();
    // Path should only include the cycle, not 'd'
    expect(res.path).not.toContain('d');
  });

  it('returns true for a disconnected graph with a cycle in one component', () => {
    const graph: Graph = {
      nodes: [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')],
      edges: [
        makeEdge('a', 'b'), // Component 1: linear
        makeEdge('c', 'd'), // Component 2: cycle
        makeEdge('d', 'c'),
      ],
    };
    expect(detectCycle(graph).hasCycle).toBe(true);
  });
});

// ─── Topological Sort Tests ──────────────────────────────────────────────────

describe('topologicalSort', () => {
  it('sorts a linear graph correctly', () => {
    const graph: Graph = {
      nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
      edges: [makeEdge('a', 'b'), makeEdge('b', 'c')],
    };
    const { order, tiers } = topologicalSort(graph);
    
    expect(order).toEqual(['a', 'b', 'c']);
    expect(tiers).toEqual([['a'], ['b'], ['c']]);
  });

  it('sorts a diamond graph and groups concurrent tiers correctly', () => {
    const graph: Graph = {
      nodes: [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')],
      edges: [
        makeEdge('a', 'b'),
        makeEdge('a', 'c'),
        makeEdge('b', 'd'),
        makeEdge('c', 'd'),
      ],
    };
    const { order, tiers } = topologicalSort(graph);
    
    // a runs first
    // b and c run together (concurrent tier)
    // d runs last
    expect(tiers.length).toBe(3);
    expect(tiers[0]).toEqual(['a']);
    // Since we sort ties lexicographically in the algo, b comes before c
    expect(tiers[1]).toEqual(['b', 'c']);
    expect(tiers[2]).toEqual(['d']);
    
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles multiple independent root nodes (disconnected components)', () => {
    const graph: Graph = {
      nodes: [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')],
      edges: [
        makeEdge('a', 'b'),
        makeEdge('c', 'd'),
      ],
    };
    const { order, tiers } = topologicalSort(graph);
    
    // a and c both have in-degree 0
    expect(tiers[0]).toEqual(['a', 'c']);
    // b and d follow
    expect(tiers[1]).toEqual(['b', 'd']);
    
    expect(order).toEqual(['a', 'c', 'b', 'd']);
  });
});
