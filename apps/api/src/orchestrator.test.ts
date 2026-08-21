/**
 * Phase 6 — Orchestrator acceptance tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@dag/db';
import { ioQueue, cpuQueue, connection } from '@dag/queue';
import { startRun, onNodeSucceeded } from './services/orchestrator.service';

const HAS_DB = Boolean(process.env['DATABASE_URL'] && !process.env['DATABASE_URL'].includes('test:test'));
const HAS_REDIS = Boolean(process.env['REDIS_URL']);
const CAN_RUN = HAS_DB && HAS_REDIS;

const ML_PIPELINE = {
  nodes: [
    { id: '1', type: 'kaggle.download', key: 'extract', config: { dataset: 'abc' } },
    { id: '2', type: 'pandas.preprocess', key: 'preprocess', config: { script: 'x.py' } },
    { id: '3', type: 'torch.train', key: 'train', config: { epochs: 10 } },
    { id: '4', type: 'model.evaluate', key: 'evaluate', config: {} },
    { id: '5', type: 'registry.deploy', key: 'deploy', config: {} },
  ],
  edges: [
    { id: 'e1', from: 'extract', to: 'preprocess' },
    { id: 'e2', from: 'preprocess', to: 'train' },
    { id: 'e3', from: 'train', to: 'evaluate' },
    { id: 'e4', from: 'evaluate', to: 'deploy' },
  ],
};

const TOPO_ORDER = {
  order: ['extract', 'preprocess', 'train', 'evaluate', 'deploy'],
  tiers: [['extract'], ['preprocess'], ['train'], ['evaluate'], ['deploy']],
};

describe.skipIf(!CAN_RUN)('Phase 6 — Orchestrator (requires DB and Redis)', () => {
  let tenantId: string;
  let workflowId: string;
  let versionId: string;
  let runId: string;

  beforeAll(async () => {
    // 1. Seed the workflow
    const tenant = await prisma.tenant.create({ data: { name: 'test-tenant' } });
    tenantId = tenant.id;

    const workflow = await prisma.workflow.create({
      data: { tenantId, name: 'Orchestrator Test' },
    });
    workflowId = workflow.id;

    const version = await prisma.workflowVersion.create({
      data: {
        workflowId,
        version: 1,
        graph: ML_PIPELINE as any,
        topoOrder: TOPO_ORDER as any,
      },
    });
    versionId = version.id;

    // Clear queues to ensure clean state
    await ioQueue.obliterate({ force: true });
    await cpuQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    // Clean up
    await prisma.runEvent.deleteMany({ where: { runId } });
    await prisma.nodeRun.deleteMany({ where: { runId } });
    await prisma.run.deleteMany({ where: { workflowVersionId: versionId } });
    await prisma.workflowVersion.delete({ where: { id: versionId } });
    await prisma.workflow.delete({ where: { id: workflowId } });
    await prisma.tenant.delete({ where: { id: tenantId } });

    await ioQueue.obliterate({ force: true }).catch(() => {});
    await cpuQueue.obliterate({ force: true }).catch(() => {});
    
    // Cleanup Redis lua keys
    if (runId) {
      await connection.del(`run:${runId}:indegree`);
      await connection.del(`run:${runId}:dispatched`);
    }
  });

  it('calling startRun leaves exactly one job in queue:io and 4 pending nodes', async () => {
    const run = await startRun(versionId);
    runId = run.id;

    expect(run.status).toBe('RUNNING');

    const nodeRuns = await prisma.nodeRun.findMany({ where: { runId } });
    
    // 5 nodes total
    expect(nodeRuns).toHaveLength(5);

    // 'extract' should be QUEUED, others PENDING
    const extractRun = nodeRuns.find((n) => n.nodeKey === 'extract')!;
    expect(extractRun.status).toBe('QUEUED');

    const pending = nodeRuns.filter((n) => n.status === 'PENDING');
    expect(pending).toHaveLength(4);

    // Check BullMQ - exactly 1 job in ioQueue, 0 in cpuQueue
    const ioJobs = await ioQueue.getWaitingCount();
    expect(ioJobs).toBe(1);

    const cpuJobs = await cpuQueue.getWaitingCount();
    expect(cpuJobs).toBe(0);

    // Verify the job payload
    const jobs = await ioQueue.getWaiting();
    expect(jobs[0]!.data.nodeKey).toBe('extract');
  });

  it('hand-completing extract triggers exactly one new job (preprocess) in cpuQueue', async () => {
    // We mock the worker by manually transitioning 'extract' to RUNNING so it can SUCCEED
    const extractRun = await prisma.nodeRun.findUnique({
      where: { runId_nodeKey: { runId, nodeKey: 'extract' } }
    });
    
    await prisma.nodeRun.update({
      where: { id: extractRun!.id },
      data: { status: 'RUNNING', workerId: 'test-worker' }
    });

    // Fire the orchestrator success hook
    await onNodeSucceeded(runId, 'extract', { rows: 100 });

    // 'extract' should be SUCCEEDED
    const updatedExtract = await prisma.nodeRun.findUnique({
      where: { id: extractRun!.id }
    });
    expect(updatedExtract!.status).toBe('SUCCEEDED');

    // 'preprocess' should now be QUEUED
    const preprocessRun = await prisma.nodeRun.findUnique({
      where: { runId_nodeKey: { runId, nodeKey: 'preprocess' } }
    });
    expect(preprocessRun!.status).toBe('QUEUED');

    // Check BullMQ - exactly 1 job in cpuQueue
    const cpuJobs = await cpuQueue.getWaitingCount();
    expect(cpuJobs).toBe(1);

    const jobs = await cpuQueue.getWaiting();
    expect(jobs[0]!.data.nodeKey).toBe('preprocess');
  });
});
