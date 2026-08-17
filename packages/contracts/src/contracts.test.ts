import { describe, it, expect } from 'vitest';
import { GraphSchema } from './graph';
import { NodeDefSchema } from './node-types';
import { RunEventSchema } from './events';
import { NodeStatusSchema, RunStatusSchema } from './status';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A minimal valid extract node */
const extractNode = {
  key: 'extract',
  type: 'kaggle.download' as const,
  label: 'Extract',
  position: { x: 0, y: 0 },
  config: { datasetSlug: 'user/dataset', outputDir: '/artifacts/raw' },
};

/** A minimal valid preprocess node */
const preprocessNode = {
  key: 'preprocess',
  type: 'pandas.preprocess' as const,
  label: 'Preprocess',
  position: { x: 200, y: 0 },
  config: {},
};

/** A valid 2-node linear graph */
const validLinearGraph = {
  nodes: [extractNode, preprocessNode],
  edges: [{ from: 'extract', to: 'preprocess' }],
};

// ─── GraphSchema — acceptance check tests ────────────────────────────────────

describe('GraphSchema', () => {
  it('parses a valid linear graph', () => {
    const result = GraphSchema.safeParse(validLinearGraph);
    expect(result.success).toBe(true);
  });

  it('parses a valid diamond graph', () => {
    const diamond = {
      nodes: [
        extractNode,
        preprocessNode,
        { key: 'train', type: 'torch.train', label: 'Train', position: { x: 400, y: -100 }, config: {} },
        { key: 'evaluate', type: 'model.evaluate', label: 'Evaluate', position: { x: 600, y: 0 }, config: {} },
      ],
      edges: [
        { from: 'extract', to: 'preprocess' },
        { from: 'preprocess', to: 'train' },
        { from: 'preprocess', to: 'evaluate' },
        { from: 'train', to: 'evaluate' },
      ],
    };
    const result = GraphSchema.safeParse(diamond);
    expect(result.success).toBe(true);
  });

  // ── ACCEPTANCE CHECK 1: duplicate node key ────────────────────────────────
  it('rejects a graph with duplicate node keys', () => {
    const graph = {
      nodes: [extractNode, { ...preprocessNode, key: 'extract' }], // ← duplicate!
      edges: [],
    };
    const result = GraphSchema.safeParse(graph);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue).toBeDefined();
      // Issue path must point to the offending node
      expect(issue?.path).toContain('nodes');
      expect(issue?.message).toMatch(/duplicate/i);
      expect(issue?.message).toContain('extract');
    }
  });

  // ── ACCEPTANCE CHECK 2: dangling edge ────────────────────────────────────
  it('rejects a graph with a dangling edge (references non-existent node)', () => {
    const graph = {
      nodes: [extractNode],
      edges: [{ from: 'extract', to: 'ghost' }], // ← 'ghost' does not exist
    };
    const result = GraphSchema.safeParse(graph);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue).toBeDefined();
      expect(issue?.path).toContain('edges');
      expect(issue?.message).toMatch(/unknown node key/i);
      expect(issue?.message).toContain('ghost');
    }
  });

  // ── ACCEPTANCE CHECK 3: self-loop ─────────────────────────────────────────
  it('rejects a graph with a self-loop', () => {
    const graph = {
      nodes: [extractNode],
      edges: [{ from: 'extract', to: 'extract' }], // ← self-loop
    };
    const result = GraphSchema.safeParse(graph);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue).toBeDefined();
      expect(issue?.path).toContain('edges');
      expect(issue?.message).toMatch(/self-loop/i);
    }
  });

  it('rejects a graph with duplicate edges', () => {
    const graph = {
      nodes: [extractNode, preprocessNode],
      edges: [
        { from: 'extract', to: 'preprocess' },
        { from: 'extract', to: 'preprocess' }, // ← duplicate
      ],
    };
    const result = GraphSchema.safeParse(graph);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue?.message).toMatch(/duplicate edge/i);
    }
  });

  it('rejects a graph exceeding MAX_NODES', () => {
    const nodes = Array.from({ length: 201 }, (_, i) => ({
      key: `node-${i}`,
      type: 'kaggle.download' as const,
      label: `Node ${i}`,
      position: { x: i * 10, y: 0 },
      config: { datasetSlug: 'u/d', outputDir: '/tmp' },
    }));
    const result = GraphSchema.safeParse({ nodes, edges: [] });
    expect(result.success).toBe(false);
  });
});

// ─── NodeDefSchema — discriminated union tests ────────────────────────────────

describe('NodeDefSchema', () => {
  it('parses a kaggle.download node', () => {
    const result = NodeDefSchema.safeParse(extractNode);
    expect(result.success).toBe(true);
  });

  it('parses a torch.train node with config', () => {
    const result = NodeDefSchema.safeParse({
      key: 'train',
      type: 'torch.train',
      label: 'Train',
      position: { x: 0, y: 0 },
      config: { epochs: 20 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown node type', () => {
    const result = NodeDefSchema.safeParse({
      key: 'unknown',
      type: 'custom.unknown', // not in the union
      label: 'Unknown',
      position: { x: 0, y: 0 },
      config: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a node key with spaces', () => {
    const result = NodeDefSchema.safeParse({
      ...extractNode,
      key: 'my node', // spaces not allowed
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/key/i);
    }
  });

  it('rejects a node key starting with a number', () => {
    const result = NodeDefSchema.safeParse({ ...extractNode, key: '1extract' });
    expect(result.success).toBe(false);
  });
});

// ─── Status enums ─────────────────────────────────────────────────────────────

describe('NodeStatusSchema', () => {
  it('accepts all valid statuses', () => {
    const statuses = ['PENDING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'];
    for (const s of statuses) {
      expect(NodeStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it('rejects an invalid status', () => {
    expect(NodeStatusSchema.safeParse('IN_PROGRESS').success).toBe(false);
  });
});

describe('RunStatusSchema', () => {
  it('accepts all valid run statuses', () => {
    const statuses = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'];
    for (const s of statuses) {
      expect(RunStatusSchema.safeParse(s).success).toBe(true);
    }
  });
});

// ─── RunEventSchema ───────────────────────────────────────────────────────────

describe('RunEventSchema', () => {
  it('parses a valid run-level event', () => {
    const result = RunEventSchema.safeParse({
      runId: 'run-abc',
      type: 'RUN_STARTED',
      payload: {},
      ts: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('parses a valid node-level event with nodeKey', () => {
    const result = RunEventSchema.safeParse({
      runId: 'run-abc',
      nodeKey: 'preprocess',
      type: 'NODE_SUCCEEDED',
      payload: { rows: 48213 },
      ts: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown event type', () => {
    const result = RunEventSchema.safeParse({
      runId: 'run-abc',
      type: 'UNKNOWN_EVENT',
      payload: {},
      ts: Date.now(),
    });
    expect(result.success).toBe(false);
  });
});
