/**
 * Shared graph problem detection (roadmap D3 — live validation panel).
 *
 * Returns a flat list of human-readable issue strings. The editor shows these
 * continuously in a dismissible panel; `handleSave` also blocks on a non-empty
 * list. Kept framework-free (plain nodes/edges in, strings out) so it's trivial
 * to unit test.
 */
import type { Node, Edge } from '@xyflow/react';
import type { NodeData } from '../store/graphSlice';

/** Config fields a node type must have set before a save will succeed. */
const REQUIRED_CONFIG: Record<string, string[]> = {
  'registry.deploy': ['registryUrl', 'modelTag'],
};

interface EdgeCondition {
  left: string;
  right: unknown;
}

export function collectGraphIssues(nodes: Node<NodeData>[], edges: Edge[]): string[] {
  const issues: string[] = [];
  if (nodes.length === 0) return issues; // an empty canvas is "nothing wrong yet"

  const labelOf = (id: string) => nodes.find((n) => n.id === id)?.data.label ?? id;

  // 1. Missing required config.
  for (const node of nodes) {
    const required = REQUIRED_CONFIG[node.data.nodeType] ?? [];
    const missing = required.filter(
      (f) => !node.data.config[f] || String(node.data.config[f]).trim() === '',
    );
    if (missing.length > 0) issues.push(`"${node.data.label}" is missing: ${missing.join(', ')}`);
  }

  // 2. Incomplete edge conditions (B1.2) — `left` is `.min(1)` on the wire.
  for (const edge of edges) {
    const c = (edge.data as { condition?: EdgeCondition } | undefined)?.condition;
    if (!c) continue;
    const rightBlank =
      c.right === '' || c.right === undefined || c.right === null ||
      (Array.isArray(c.right) && c.right.length === 0);
    if (!c.left.trim() || rightBlank) {
      issues.push(`Edge ${labelOf(edge.source)} → ${labelOf(edge.target)} has an incomplete condition`);
    }
  }

  // 3. Orphan nodes — a node touching no edge at all, when the graph has more
  //    than one node (a single lone node is a legitimate one-step pipeline).
  if (nodes.length > 1) {
    const touched = new Set<string>();
    for (const e of edges) { touched.add(e.source); touched.add(e.target); }
    for (const n of nodes) {
      if (!touched.has(n.id)) issues.push(`"${n.data.label}" is not connected to anything`);
    }
  }

  // 4. Unreachable nodes — can't be reached by following edges forward from any
  //    root (a node with no incoming edge). Skipped if there's no root at all
  //    (that means a cycle, which the editor already blocks on connect).
  const incoming = new Map<string, number>();
  nodes.forEach((n) => incoming.set(n.id, 0));
  edges.forEach((e) => incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1));
  const roots = nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id);
  if (roots.length > 0) {
    const adj = new Map<string, string[]>();
    edges.forEach((e) => adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]));
    const seen = new Set<string>(roots);
    const queue = [...roots];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    for (const n of nodes) {
      if (!seen.has(n.id)) issues.push(`"${n.data.label}" is unreachable from any starting node`);
    }
  }

  return issues;
}
