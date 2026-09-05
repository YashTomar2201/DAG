/**
 * Phase 4 — Control Plane API acceptance tests
 *
 * Acceptance check (from build-dag-engine.md):
 *   1. POST a cyclic graph → 422 whose body contains the offending cycle path.
 *   2. POST the 5-node ML pipeline → 201 with a persisted topoOrder of
 *      [extract, preprocess, train, evaluate, deploy].
 *
 * These tests mock the DB layer so they run without a real Postgres instance.
 * Integration tests against a real DB are in Phase 12 (Testcontainers).
 */

import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from './app';

// ─── Mock @dag/db ─────────────────────────────────────────────────────────────
// We test the control-plane logic (validation, cycle detection, topo sort) in
// isolation. DB persistence is verified in Phase 12's integration tests.

/** A fake API key these tests authenticate with — see `findActiveApiKeyByHash` below. */
export const TEST_API_KEY = 'test-api-key';
const TEST_API_KEY_HASH = createHash('sha256').update(TEST_API_KEY).digest('hex');

vi.mock('@dag/db', () => ({
  prisma: {
    workflow: {
      findUnique: vi.fn().mockResolvedValue({ id: 'wf-1' }),
    },
  },
  createWorkflow: vi.fn().mockResolvedValue({ workflowId: 'wf-1', versionId: 'v-1' }),
  createWorkflowVersion: vi.fn().mockImplementation(async (_wfId: string, graph: unknown, topoOrder: unknown) => ({
    id: 'v-2',
    workflowId: 'wf-1',
    version: 2,
    graph,
    topoOrder,
    createdAt: new Date(),
  })),
  createRun: vi.fn(),
  getRunEvents: vi.fn().mockResolvedValue([]),
  // Roadmap A3 — requireApiKey looks this up on every protected route. Real
  // auth logic runs here (wrong/missing key genuinely 401s); only the DB
  // lookup behind it is faked.
  findActiveApiKeyByHash: vi.fn().mockImplementation(async (hash: string) =>
    hash === TEST_API_KEY_HASH ? { id: 'key-1', tenantId: 'tenant-1', name: 'test-key' } : null,
  ),
  // A3 also needs this for createVersionService's ownership check.
  workflowBelongsToTenant: vi.fn().mockResolvedValue(true),
}));

// ─── Test fixtures ────────────────────────────────────────────────────────────

/** The 5-node ML pipeline from PROJECT_GUIDE.md §1 */
const ML_PIPELINE_GRAPH = {
  nodes: [
    { key: 'extract',    type: 'data.source',      label: 'Extract',    position: { x: 0, y: 0 }, config: {} },
    { key: 'preprocess', type: 'pandas.preprocess', label: 'Preprocess', position: { x: 1, y: 0 }, config: { scriptPath: 'python/preprocess.py' } },
    { key: 'train',      type: 'torch.train',       label: 'Train',      position: { x: 2, y: 0 }, config: { scriptPath: 'python/train.py', epochs: 10 } },
    { key: 'evaluate',   type: 'model.evaluate',    label: 'Evaluate',   position: { x: 3, y: 0 }, config: { scriptPath: 'python/evaluate.py' } },
    { key: 'deploy',     type: 'registry.deploy',   label: 'Deploy',     position: { x: 4, y: 0 }, config: { registryUrl: 'https://docker.io', modelTag: 'my-model:latest' } },
  ],
  edges: [
    { from: 'extract',    to: 'preprocess' },
    { from: 'preprocess', to: 'train' },
    { from: 'train',      to: 'evaluate' },
    { from: 'evaluate',   to: 'deploy' },
  ],
};

/** A graph with a cycle: deploy → extract */
const CYCLIC_GRAPH = {
  nodes: ML_PIPELINE_GRAPH.nodes,
  edges: [
    ...ML_PIPELINE_GRAPH.edges,
    { from: 'deploy', to: 'extract' }, // ← introduces the cycle
  ],
};

/** A graph with a duplicate node key */
const DUPLICATE_KEY_GRAPH = {
  nodes: [
    { key: 'a', type: 'pandas.preprocess', label: 'A', position: { x: 0, y: 0 }, config: { scriptPath: 'p.py' } },
    { key: 'a', type: 'pandas.preprocess', label: 'A-dup', position: { x: 1, y: 0 }, config: { scriptPath: 'p.py' } },
  ],
  edges: [],
};

/** A graph with a dangling edge */
const DANGLING_EDGE_GRAPH = {
  nodes: [
    { key: 'a', type: 'pandas.preprocess', label: 'A', position: { x: 0, y: 0 }, config: { scriptPath: 'p.py' } },
  ],
  edges: [{ from: 'a', to: 'ghost' }],
};

/** A graph with a self-loop */
const SELF_LOOP_GRAPH = {
  nodes: [
    { key: 'a', type: 'pandas.preprocess', label: 'A', position: { x: 0, y: 0 }, config: { scriptPath: 'p.py' } },
  ],
  edges: [{ from: 'a', to: 'a' }],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Phase 4 — Control Plane API', () => {
  const app = createApp();

  /** Every protected route needs this now (roadmap A3) — see the `@dag/db` mock above. */
  const AUTH = { Authorization: `Bearer ${TEST_API_KEY}` };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Health check ────────────────────────────────────────────────────────────

  it('GET /health → 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  // ── Auth (roadmap A3) ────────────────────────────────────────────────────────

  it('POST /workflows with no Authorization header → 401', async () => {
    const res = await request(app)
      .post('/workflows')
      .send({ name: 'No Auth', graph: ML_PIPELINE_GRAPH });
    expect(res.status).toBe(401);
  });

  it('POST /workflows with an invalid API key → 401', async () => {
    const res = await request(app)
      .post('/workflows')
      .set('Authorization', 'Bearer not-a-real-key')
      .send({ name: 'Bad Key', graph: ML_PIPELINE_GRAPH });
    expect(res.status).toBe(401);
  });

  // ── POST /workflows — acceptance check 2 ───────────────────────────────────

  it('POST /workflows with the 5-node ML pipeline → 201 with workflowId + versionId', async () => {
    const res = await request(app)
      .post('/workflows')
      .set(AUTH)
      .send({ name: 'ML Pipeline', graph: ML_PIPELINE_GRAPH });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ workflowId: 'wf-1', versionId: 'v-1' });
  });

  // ── POST /workflows/:id/versions — acceptance check 1 & 2 ─────────────────

  it('POST /workflows/:id/versions with a cyclic graph → 422 with cyclePath', async () => {
    const res = await request(app)
      .post('/workflows/wf-1/versions')
      .set(AUTH)
      .send({ graph: CYCLIC_GRAPH });

    expect(res.status).toBe(422);
    expect(res.body.cyclePath).toBeDefined();
    expect(Array.isArray(res.body.cyclePath)).toBe(true);
    // The cycle path must start and end at the same node
    const path: string[] = res.body.cyclePath;
    expect(path[0]).toBe(path[path.length - 1]);
  });

  it('POST /workflows/:id/versions with a valid graph → 201 with correct topoOrder', async () => {
    const res = await request(app)
      .post('/workflows/wf-1/versions')
      .set(AUTH)
      .send({ graph: ML_PIPELINE_GRAPH });

    expect(res.status).toBe(201);
    // The mock returns the topoOrder passed to createWorkflowVersion
    const topoOrder = res.body.topoOrder as { order: string[]; tiers: string[][] };
    expect(topoOrder.order).toEqual(['extract', 'preprocess', 'train', 'evaluate', 'deploy']);
    expect(topoOrder.tiers).toEqual([
      ['extract'],
      ['preprocess'],
      ['train'],
      ['evaluate'],
      ['deploy'],
    ]);
  });

  // ── POST /workflows/:id/validate ───────────────────────────────────────────

  it('POST /workflows/:id/validate with valid graph → 200 { valid: true }', async () => {
    const res = await request(app)
      .post('/workflows/wf-1/validate')
      .set(AUTH)
      .send({ graph: ML_PIPELINE_GRAPH });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.topoOrder).toBeDefined();
  });

  it('POST /workflows/:id/validate with cyclic graph → 200 { valid: false, cyclePath }', async () => {
    const res = await request(app)
      .post('/workflows/wf-1/validate')
      .set(AUTH)
      .send({ graph: CYCLIC_GRAPH });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.cyclePath).toBeDefined();
  });

  it('POST /workflows/:id/validate with duplicate node key → 200 { valid: false, zodIssues }', async () => {
    const res = await request(app)
      .post('/workflows/wf-1/validate')
      .set(AUTH)
      .send({ graph: DUPLICATE_KEY_GRAPH });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.zodIssues).toBeDefined();
    expect(res.body.zodIssues[0].message).toContain('Duplicate node key');
  });

  it('POST /workflows/:id/validate with dangling edge → 200 { valid: false, zodIssues }', async () => {
    const res = await request(app)
      .post('/workflows/wf-1/validate')
      .set(AUTH)
      .send({ graph: DANGLING_EDGE_GRAPH });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.zodIssues?.some((i: { message: string }) => i.message.includes('ghost'))).toBe(true);
  });

  it('POST /workflows/:id/validate with self-loop → 200 { valid: false, zodIssues }', async () => {
    const res = await request(app)
      .post('/workflows/wf-1/validate')
      .set(AUTH)
      .send({ graph: SELF_LOOP_GRAPH });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.zodIssues?.some((i: { message: string }) => i.message.includes('Self-loop'))).toBe(true);
  });
});
