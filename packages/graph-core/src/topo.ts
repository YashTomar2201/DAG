import type { Graph } from '@dag/contracts';
import { buildAdjacencyMap } from './adjacency';

export interface TopologicalSortResult {
  /** The flat array of nodeKeys in execution order. */
  order: string[];
  /** 
   * A 2D array representing execution tiers.
   * Nodes in the same inner array can execute concurrently.
   */
  tiers: string[][];
}

/**
 * Kahn's Algorithm for Topological Sort.
 * Note: this function assumes the graph has NO cycles. 
 * You MUST run `detectCycle()` and fail early before running this.
 */
export function topologicalSort(graph: Graph): TopologicalSortResult {
  const { adj, inDegree } = buildAdjacencyMap(graph);

  const order: string[] = [];
  const tiers: string[][] = [];

  // Find all initial nodes (in-degree 0)
  let currentTier: string[] = [];
  for (const [node, degree] of inDegree.entries()) {
    if (degree === 0) {
      currentTier.push(node);
    }
  }

  // Sort tiers lexicographically just for deterministic output in tests/execution
  currentTier.sort();

  while (currentTier.length > 0) {
    tiers.push([...currentTier]);
    order.push(...currentTier);

    const nextTier: string[] = [];

    for (const u of currentTier) {
      const children = adj.get(u) ?? [];
      for (const v of children) {
        const currentDegree = inDegree.get(v)!;
        inDegree.set(v, currentDegree - 1);

        if (currentDegree - 1 === 0) {
          nextTier.push(v);
        }
      }
    }

    // Sort again for determinism
    nextTier.sort();
    currentTier = nextTier;
  }

  // If order.length !== graph.nodes.length, a cycle exists.
  // But we rely on detectCycle() as the source of truth for cycle reporting,
  // so we just return whatever we have.

  return { order, tiers };
}
