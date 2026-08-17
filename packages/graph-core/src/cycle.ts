import type { Graph } from '@dag/contracts';
import { buildAdjacencyMap } from './adjacency';

export interface CycleDetectionResult {
  hasCycle: boolean;
  /** If a cycle is found, an array of node keys representing the exact loop path */
  path?: string[];
}

/**
 * Iterative Depth-First Search (DFS) with 3-state coloring to detect cycles.
 * 
 * Colors:
 * - WHITE (unvisited, implicitly not in maps)
 * - GRAY (visiting, currently on the recursion stack)
 * - BLACK (visited, all children explored, confirmed cycle-free)
 * 
 * Iterative approach is used over recursion to prevent "Maximum call stack size exceeded" 
 * for extremely deep linear graphs (though Zod MAX_NODES mitigates this).
 */
export function detectCycle(graph: Graph): CycleDetectionResult {
  const { adj } = buildAdjacencyMap(graph);

  const colors = new Map<string, 'GRAY' | 'BLACK'>();
  
  // Track the traversal path to reconstruct the cycle if found
  const parentMap = new Map<string, string>();

  // Use a stack to simulate the call stack of a recursive DFS
  // A frame is: [nodeKey, indexOfNextChildToProcess]
  for (const startNode of graph.nodes) {
    if (!startNode) continue;
    if (colors.has(startNode.key)) continue; // Already fully explored

    const stack: [string, number][] = [[startNode.key, 0]];
    colors.set(startNode.key, 'GRAY');

    while (stack.length > 0) {
      // We know stack is non-empty here
      const frame = stack[stack.length - 1];
      if (!frame) break; 
      
      const [u, childIndex] = frame;
      const children = adj.get(u) ?? [];

      if (childIndex < children.length) {
        // Process next child
        const v = children[childIndex];
        if (!v) continue;

        // Advance the child index for `u` in the stack frame
        frame[1]++;

        const childColor = colors.get(v);

        if (childColor === 'GRAY') {
          // Cycle detected! Backtrack to build the exact cycle path
          const cyclePath: string[] = [v, u];
          let current = u;
          while (current !== v) {
            const p = parentMap.get(current);
            if (!p) break;
            cyclePath.push(p);
            current = p;
          }
          return { hasCycle: true, path: cyclePath.reverse() };
        } else if (childColor === undefined) {
          // Unvisited (WHITE). Push to stack and mark GRAY.
          colors.set(v, 'GRAY');
          parentMap.set(v, u);
          stack.push([v, 0]);
        }
      } else {
        // Finished all children of `u`
        colors.set(u, 'BLACK');
        stack.pop();
      }
    }
  }

  return { hasCycle: false };
}
