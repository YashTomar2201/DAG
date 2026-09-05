/**
 * Phase 12 — /metrics unit tests.
 *
 * Mocks @dag/db and @dag/queue (same pattern as api.test.ts) so this runs
 * without a real Postgres/Redis — it verifies the route wiring and the
 * Prometheus text-exposition-format output shape, not live scaling numbers
 * (that's what the Testcontainers integration suite and the scale test are for).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { env } from './env';

vi.mock('@dag/db', () => ({
  countNodeRunsByStatus: vi.fn().mockResolvedValue({ SUCCEEDED: 3, RUNNING: 1, FAILED: 0 }),
  countRunsByStatus: vi.fn().mockResolvedValue({ SUCCEEDED: 1, RUNNING: 1 }),
}));

function makeMockQueue() {
  return {
    getWaitingCount: vi.fn().mockResolvedValue(2),
    getActiveCount: vi.fn().mockResolvedValue(1),
    getWorkers: vi.fn().mockResolvedValue([{ id: 'w1' }, { id: 'w2' }]),
  };
}

vi.mock('@dag/queue', () => ({
  ioQueue: makeMockQueue(),
  cpuQueue: makeMockQueue(),
  gpuQueue: makeMockQueue(),
}));

describe('GET /metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a scrape with no metrics token (roadmap A3)', async () => {
    const { createApp } = await import('./app');
    const app = createApp();

    const res = await request(app).get('/metrics');
    expect(res.status).toBe(401);
  });

  it('returns Prometheus text-exposition format with all four metric families', async () => {
    const { createApp } = await import('./app');
    const app = createApp();

    const res = await request(app).get('/metrics').set('Authorization', `Bearer ${env.METRICS_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);

    // Job status
    expect(res.text).toContain('# TYPE dag_node_runs_by_status gauge');
    expect(res.text).toContain('dag_node_runs_by_status{status="SUCCEEDED"} 3');
    expect(res.text).toContain('dag_runs_by_status{status="RUNNING"} 1');

    // Queue depth
    expect(res.text).toContain('# TYPE dag_queue_depth gauge');
    expect(res.text).toContain('dag_queue_depth{queue="io",state="waiting"} 2');
    expect(res.text).toContain('dag_queue_depth{queue="cpu",state="active"} 1');

    // Active workers
    expect(res.text).toContain('# TYPE dag_active_workers gauge');
    expect(res.text).toContain('dag_active_workers{queue="gpu"} 2');

    // Node duration histogram is declared even with zero observations yet
    expect(res.text).toContain('# TYPE dag_node_duration_seconds histogram');
  });

  it('observes into the histogram and reflects it on the next scrape', async () => {
    const { nodeDurationSeconds } = await import('./metrics');
    const { createApp } = await import('./app');
    const app = createApp();

    nodeDurationSeconds.observe({ nodeType: 'pandas.preprocess', outcome: 'succeeded' }, 1.5);

    const res = await request(app).get('/metrics').set('Authorization', `Bearer ${env.METRICS_TOKEN}`);
    expect(res.text).toContain('dag_node_duration_seconds_count{nodeType="pandas.preprocess",outcome="succeeded"} 1');
  });
});
