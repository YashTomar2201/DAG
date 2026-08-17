import { z } from 'zod';
import { NodeDefSchema } from './node-types';

// ─── Edge ──────────────────────────────────────────────────────────────────

export const EdgeDefSchema = z.object({
  /** Key of the source node */
  from: z.string().min(1),
  /** Key of the destination node */
  to: z.string().min(1),
});

export type EdgeDef = z.infer<typeof EdgeDefSchema>;

// ─── Graph constants ───────────────────────────────────────────────────────

/** Hard limit on nodes per graph. Prevents runaway fan-out at design time. */
export const MAX_NODES = 200;

// ─── Graph schema with structural refinements ─────────────────────────────
// Structural rules enforced HERE (in Zod, at parse time):
//   ✔  Node keys are unique within the graph
//   ✔  Every edge endpoint refers to a real node key (no dangling edges)
//   ✔  No self-loops (edge.from !== edge.to)
//   ✔  No duplicate edges (same from/to pair)
//   ✔  Node count <= MAX_NODES
//
// Rules deliberately NOT enforced here:
//   ✗  Cycle detection  — requires graph traversal (DFS); Zod runs per-field,
//                         not over the graph as a whole. Cycles are caught by
//                         `detectCycle` in packages/graph-core (Phase 2).
//   ✗  Reachability     — whether every node is reachable from a root is a
//                         graph property, not a schema property. Flagged as a
//                         warning (not error) in `validateGraph`.

export const GraphSchema = z
  .object({
    nodes: z.array(NodeDefSchema).max(MAX_NODES, `A graph may have at most ${MAX_NODES} nodes`),
    edges: z.array(EdgeDefSchema),
  })
  .superRefine((graph, ctx) => {
    const nodeKeys = new Set<string>();

    // ── Rule 1: node keys must be unique ──────────────────────────────────
    for (let i = 0; i < graph.nodes.length; i++) {
      const node = graph.nodes[i];
      if (!node) continue;
      if (nodeKeys.has(node.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', i, 'key'],
          message: `Duplicate node key: "${node.key}". Every node must have a unique key.`,
        });
      }
      nodeKeys.add(node.key);
    }

    const edgeSeen = new Set<string>();

    for (let i = 0; i < graph.edges.length; i++) {
      const edge = graph.edges[i];
      if (!edge) continue;

      // ── Rule 2: no self-loops ──────────────────────────────────────────
      if (edge.from === edge.to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', i],
          message: `Self-loop on node "${edge.from}". A node cannot depend on itself.`,
        });
      }

      // ── Rule 3: dangling edges ─────────────────────────────────────────
      if (!nodeKeys.has(edge.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', i, 'from'],
          message: `Edge references unknown node key "${edge.from}".`,
        });
      }
      if (!nodeKeys.has(edge.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', i, 'to'],
          message: `Edge references unknown node key "${edge.to}".`,
        });
      }

      // ── Rule 4: no duplicate edges ────────────────────────────────────
      const edgeId = `${edge.from}→${edge.to}`;
      if (edgeSeen.has(edgeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', i],
          message: `Duplicate edge from "${edge.from}" to "${edge.to}".`,
        });
      }
      edgeSeen.add(edgeId);
    }
  });

export type Graph = z.infer<typeof GraphSchema>;
