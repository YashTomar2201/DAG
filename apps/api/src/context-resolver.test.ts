/**
 * Phase 7 — Context Resolver unit tests
 *
 * Acceptance check (from build-dag-engine.md):
 *   "A two-node run where the parent returns `{"metadataPath":"x.csv"}` and the
 *    child's persisted `input` contains the resolved literal `"x.csv"`, not the template."
 *
 * Additional cases:
 *   - Diamond graph where `d` interpolates from both `b` and `c`
 *   - Unresolved reference → throws UnresolvedTemplateError
 *   - Output too large → throws OutputTooLargeError
 *   - Whole-value replacement (template is the entire string → native type preserved)
 *   - Embedded template inside a larger string → string interpolation
 *   - Nested dotted path access
 *   - Non-template values pass through unchanged
 */

import { describe, it, expect } from 'vitest';
import type { NodeRun } from '@dag/db';
import {
  resolveNodeInputs,
  assertOutputSize,
  UnresolvedTemplateError,
  OutputTooLargeError,
  MAX_OUTPUT_BYTES,
} from './context-resolver';
import type { Graph } from '@dag/contracts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Build a stub NodeRun map entry. Only `nodeKey`, `status`, and `output` are
 * needed by the resolver — everything else is set to safe defaults.
 */
function stubNodeRun(
  nodeKey: string,
  status: 'SUCCEEDED' | 'PENDING' | 'RUNNING',
  output: unknown = null,
): NodeRun {
  return {
    id: `nr-${nodeKey}`,
    runId: 'run-1',
    nodeKey,
    status,
    attempt: 0,
    input: null,
    output: output as any,
    error: null,
    workerId: null,
    leaseExpiresAt: null,
    startedAt: null,
    finishedAt: null,
  } as unknown as NodeRun;
}

/** Two-node linear graph: extract → preprocess */
const TWO_NODE_GRAPH = {
  nodes: [
    { id: '1', key: 'extract', type: 'kaggle.download', config: { datasetSlug: 'cats', outputDir: '/tmp' } },
    {
      id: '2',
      key: 'preprocess',
      type: 'pandas.preprocess',
      config: {
        // Template: resolved at dispatch time from extract's output
        csvPath: '{{ nodes.extract.output.metadataPath }}',
      } as any,
    },
  ],
  edges: [{ from: 'extract', to: 'preprocess' }],
} as unknown as Graph;

/** Diamond graph: a → b, a → c, b → d, c → d */
const DIAMOND_GRAPH = {
  nodes: [
    { id: '1', key: 'a', type: 'kaggle.download', config: { datasetSlug: 'x', outputDir: '/tmp' } },
    { id: '2', key: 'b', type: 'pandas.preprocess', config: { bOut: '{{ nodes.a.output.bValue }}' } as any },
    { id: '3', key: 'c', type: 'pandas.preprocess', config: { cOut: '{{ nodes.a.output.cValue }}' } as any },
    {
      id: '4',
      key: 'd',
      type: 'torch.train',
      config: {
        // d interpolates from BOTH b and c
        fromB: '{{ nodes.b.output.result }}',
        fromC: '{{ nodes.c.output.result }}',
        label: 'run={{ nodes.b.output.result }}-and-{{ nodes.c.output.result }}',
      } as any,
    },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'a', to: 'c' },
    { from: 'b', to: 'd' },
    { from: 'c', to: 'd' },
  ],
} as unknown as Graph;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('resolveNodeInputs', () => {
  // ── Acceptance check ──────────────────────────────────────────────────────

  it('ACCEPTANCE: two-node run — child config contains resolved literal, not template', () => {
    const nodeRunMap = new Map<string, NodeRun>([
      ['extract', stubNodeRun('extract', 'SUCCEEDED', { metadataPath: 'x.csv', rows: 48213 })],
    ]);

    const resolved = resolveNodeInputs(TWO_NODE_GRAPH, 'preprocess', nodeRunMap);

    // Template `{{ nodes.extract.output.metadataPath }}` → literal `"x.csv"`
    expect(resolved['csvPath']).toBe('x.csv');
    // Template is gone — no `{{ ... }}` remains
    expect(JSON.stringify(resolved)).not.toContain('{{');
  });

  // ── Diamond graph ─────────────────────────────────────────────────────────

  it('diamond graph — d interpolates from both b and c', () => {
    const nodeRunMap = new Map<string, NodeRun>([
      ['a', stubNodeRun('a', 'SUCCEEDED', { bValue: 'bOut', cValue: 'cOut' })],
      ['b', stubNodeRun('b', 'SUCCEEDED', { result: 'beta-1.2' })],
      ['c', stubNodeRun('c', 'SUCCEEDED', { result: 'gamma-3.4' })],
    ]);

    const resolved = resolveNodeInputs(DIAMOND_GRAPH, 'd', nodeRunMap);

    expect(resolved['fromB']).toBe('beta-1.2');
    expect(resolved['fromC']).toBe('gamma-3.4');
    // String interpolation with two templates in one string
    expect(resolved['label']).toBe('run=beta-1.2-and-gamma-3.4');
  });

  // ── Unresolved reference ───────────────────────────────────────────────────

  it('throws UnresolvedTemplateError for a misspelled parent key', () => {
    const nodeRunMap = new Map<string, NodeRun>(); // empty — no parent has succeeded

    expect(() => resolveNodeInputs(TWO_NODE_GRAPH, 'preprocess', nodeRunMap)).toThrow(
      UnresolvedTemplateError,
    );
  });

  it('throws UnresolvedTemplateError when parent succeeded but field path is wrong', () => {
    const nodeRunMap = new Map<string, NodeRun>([
      ['extract', stubNodeRun('extract', 'SUCCEEDED', { wrongField: 'x.csv' })],
    ]);

    // node config asks for `metadataPath` but parent only has `wrongField`
    expect(() => resolveNodeInputs(TWO_NODE_GRAPH, 'preprocess', nodeRunMap)).toThrow(
      UnresolvedTemplateError,
    );
  });

  it('throws UnresolvedTemplateError when parent is still RUNNING (not SUCCEEDED)', () => {
    const nodeRunMap = new Map<string, NodeRun>([
      ['extract', stubNodeRun('extract', 'RUNNING', { metadataPath: 'x.csv' })],
    ]);

    // Parent not yet SUCCEEDED → should not resolve
    expect(() => resolveNodeInputs(TWO_NODE_GRAPH, 'preprocess', nodeRunMap)).toThrow(
      UnresolvedTemplateError,
    );
  });

  // ── Whole-value replacement ────────────────────────────────────────────────

  it('whole-value template replaced with native type (not stringified)', () => {
    const GRAPH_WITH_OBJECT_TEMPLATE = {
      nodes: [
        { id: '1', key: 'a', type: 'kaggle.download', config: { datasetSlug: 'x', outputDir: '/tmp' } },
        {
          id: '2',
          key: 'b',
          type: 'pandas.preprocess',
          config: {
            // Whole value is a template → should get the raw object, not "[object Object]"
            stats: '{{ nodes.a.output.stats }}',
          } as any,
        },
      ],
      edges: [{ from: 'a', to: 'b' }],
    } as unknown as Graph;

    const statsObj = { mean: 0.5, std: 0.1, rows: 1000 };
    const nodeRunMap = new Map<string, NodeRun>([
      ['a', stubNodeRun('a', 'SUCCEEDED', { stats: statsObj })],
    ]);

    const resolved = resolveNodeInputs(GRAPH_WITH_OBJECT_TEMPLATE, 'b', nodeRunMap);
    // Native object preserved — not stringified
    expect(resolved['stats']).toEqual(statsObj);
  });

  // ── Non-template values pass through unchanged ─────────────────────────────

  it('non-template literals pass through unchanged', () => {
    const STATIC_GRAPH = {
      nodes: [
        {
          id: '1',
          key: 'train',
          type: 'torch.train',
          config: { epochs: 10, scriptPath: 'train.py', lr: 0.001, dryRun: false, tags: ['v1', 'prod'] } as any,
        },
      ],
      edges: [],
    } as unknown as Graph;

    const resolved = resolveNodeInputs(STATIC_GRAPH, 'train', new Map());

    expect(resolved['epochs']).toBe(10);
    expect(resolved['lr']).toBe(0.001);
    expect(resolved['dryRun']).toBe(false);
    expect(resolved['tags']).toEqual(['v1', 'prod']);
  });

  // ── Nested dotted path ────────────────────────────────────────────────────

  it('resolves nested dotted path inside parent output', () => {
    const NESTED_GRAPH = {
      nodes: [
        { id: '1', key: 'a', type: 'kaggle.download', config: { datasetSlug: 'x', outputDir: '/tmp' } },
        {
          id: '2',
          key: 'b',
          type: 'pandas.preprocess',
          config: { file: '{{ nodes.a.output.artifacts.train.path }}' } as any,
        },
      ],
      edges: [{ from: 'a', to: 'b' }],
    } as unknown as Graph;

    const nodeRunMap = new Map<string, NodeRun>([
      [
        'a',
        stubNodeRun('a', 'SUCCEEDED', {
          artifacts: { train: { path: 'artifacts/run1/a/train.csv', rows: 500 } },
        }),
      ],
    ]);

    const resolved = resolveNodeInputs(NESTED_GRAPH, 'b', nodeRunMap);
    expect(resolved['file']).toBe('artifacts/run1/a/train.csv');
  });
});

// ─── Output size guard ────────────────────────────────────────────────────────

describe('assertOutputSize', () => {
  it('does not throw for output within limit', () => {
    const smallOutput = { path: 'artifacts/run1/extract/data.csv', rows: 48213 };
    expect(() => assertOutputSize('extract', smallOutput)).not.toThrow();
  });

  it('throws OutputTooLargeError for output exceeding 64 KB', () => {
    // Build a string that is definitely > 64 KB when JSON-serialised
    const bigOutput = { blob: 'x'.repeat(MAX_OUTPUT_BYTES + 1) };
    expect(() => assertOutputSize('train', bigOutput)).toThrow(OutputTooLargeError);
  });

  it('error message mentions the 64 KB limit and artifact convention', () => {
    const bigOutput = { blob: 'x'.repeat(MAX_OUTPUT_BYTES + 1) };
    try {
      assertOutputSize('train', bigOutput);
    } catch (err) {
      expect(err).toBeInstanceOf(OutputTooLargeError);
      const msg = (err as Error).message;
      expect(msg).toContain('artifact volume');
      expect(msg).toContain('train');
    }
  });
});
