import { describe, it, expect } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import type { NodeData } from '../store/graphSlice';
import { collectGraphIssues } from './graphIssues';

function n(id: string, nodeType = 'data.source', config: Record<string, unknown> = {}): Node<NodeData> {
  return { id, position: { x: 0, y: 0 }, type: 'dagNode', data: { label: id, nodeType, config } };
}
function e(source: string, target: string, data?: unknown): Edge {
  return { id: `${source}-${target}`, source, target, ...(data ? { data } : {}) } as Edge;
}

describe('collectGraphIssues (D3)', () => {
  it('an empty canvas has no issues', () => {
    expect(collectGraphIssues([], [])).toEqual([]);
  });

  it('a clean linear graph has no issues', () => {
    const nodes = [n('a'), n('b'), n('c')];
    const edges = [e('a', 'b'), e('b', 'c')];
    expect(collectGraphIssues(nodes, edges)).toEqual([]);
  });

  it('flags a node missing required config', () => {
    const nodes = [n('a'), n('deploy', 'registry.deploy', { registryUrl: 'x' })];
    const issues = collectGraphIssues(nodes, [e('a', 'deploy')]);
    expect(issues.some((i) => i.includes('deploy') && i.includes('modelTag'))).toBe(true);
  });

  it('flags an orphan node (>1 node, touches no edge)', () => {
    const nodes = [n('a'), n('b'), n('lonely')];
    const issues = collectGraphIssues(nodes, [e('a', 'b')]);
    expect(issues.some((i) => i.includes('lonely') && i.includes('not connected'))).toBe(true);
  });

  it('does not flag a single lone node', () => {
    expect(collectGraphIssues([n('a')], [])).toEqual([]);
  });

  it('flags an unreachable node (edge only points away from a root)', () => {
    // root -> mid ; island1 -> island2  (island1 is a root too, so island2 is reachable)
    // Make island unreachable: b -> c where nothing points at b and b is NOT a root
    // by also having a -> b -> c but c also has an extra parent d with d unreachable.
    const nodes = [n('a'), n('b'), n('c'), n('x'), n('y')];
    // a->b->c is fine. x->y where y feeds back into... no. Instead: y has an incoming
    // edge (from x) AND x has an incoming edge (from y) => cycle, no roots there,
    // but a is a root so BFS from a covers a,b,c; x and y are unreachable.
    const edges = [e('a', 'b'), e('b', 'c'), e('x', 'y'), e('y', 'x')];
    const issues = collectGraphIssues(nodes, edges);
    expect(issues.some((i) => i.includes('"x"') && i.includes('unreachable'))).toBe(true);
    expect(issues.some((i) => i.includes('"y"') && i.includes('unreachable'))).toBe(true);
  });

  it('flags an incomplete edge condition', () => {
    const nodes = [n('a'), n('b')];
    const edges = [e('a', 'b', { condition: { left: '', op: 'gt', right: 1 } })];
    const issues = collectGraphIssues(nodes, edges);
    expect(issues.some((i) => i.includes('incomplete condition'))).toBe(true);
  });
});
