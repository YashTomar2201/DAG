import type { Graph, EdgeDef } from '@dag/contracts';

export interface AdjacencyStructures {
  /** Map from a nodeKey to an array of its children's nodeKeys (out-edges) */
  adj: Map<string, string[]>;
  /** Map from a nodeKey to the number of parents it has (in-edges) */
  inDegree: Map<string, number>;
}

/**
 * Builds adjacency maps required for graph traversal.
 * Ensures every node in the graph is initialized in both maps,
 * even if it has no edges (disconnected/island node).
 */
export function buildAdjacencyMap(graph: Graph): AdjacencyStructures {
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  // Initialize all nodes
  for (const node of graph.nodes) {
    if (!node) continue;
    adj.set(node.key, []);
    inDegree.set(node.key, 0);
  }

  // Populate edges
  for (const edge of graph.edges) {
    if (!edge) continue;
    
    // Add to adjacency list (from -> to)
    const children = adj.get(edge.from);
    if (children) {
      children.push(edge.to);
    }

    // Increment in-degree of destination
    const currentInDegree = inDegree.get(edge.to) ?? 0;
    inDegree.set(edge.to, currentInDegree + 1);
  }

  return { adj, inDegree };
}
