import { Queue } from 'bullmq';
import { connection } from './redis';
import type { NodeType } from '@dag/contracts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface JobPayload {
  runId: string;
  nodeKey: string;
  nodeRunId: string;
  type: NodeType;
  config: unknown; // Will be cast/validated by the worker based on type
  input: unknown;  // Will be the resolved template inputs from context passing
  attempt: number;
}

// ─── Queue Definitions ────────────────────────────────────────────────────────

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponentialJitter', // Custom strategy registered on the Worker
    delay: 2000,
  },
  removeOnComplete: { age: 86400 }, // Keep completed jobs for 24 hours
  removeOnFail: false, // Never automatically remove failed jobs
};

/**
 * queue:io - For network-bound tasks like loading/fetching datasets (data.source)
 * and registry deploys. Workers can run with high concurrency here.
 */
export const ioQueue = new Queue<JobPayload>('io', {
  connection,
  defaultJobOptions,
});

/**
 * queue:cpu - For CPU-bound tasks like pandas preprocessing or model evaluation.
 */
export const cpuQueue = new Queue<JobPayload>('cpu', {
  connection,
  defaultJobOptions,
});

/**
 * queue:gpu - For GPU-bound tasks like model training.
 * Workers usually run with concurrency 1 here.
 */
export const gpuQueue = new Queue<JobPayload>('gpu', {
  connection,
  defaultJobOptions,
});

// Helper map to pick the right queue based on node type
// You could also add this to the node definition in contracts, but routing
// logic usually belongs to the queue layer.
export const queueForType = (type: NodeType): Queue<JobPayload> => {
  switch (type) {
    case 'data.source':
    case 'registry.deploy':
    case 'flow.map': // trivial control-plane echo; no heavy work
      return ioQueue;
    case 'pandas.preprocess':
    case 'model.evaluate':
      return cpuQueue;
    case 'torch.train':
      return gpuQueue;
    default:
      // Fallback to CPU if unknown
      return cpuQueue;
  }
};

/**
 * Helper to generate a deterministic jobId.
 * BullMQ silently ignores a duplicate jobId while that job exists (waiting/active/delayed/failed),
 * giving queue-level deduplication for free.
 */
export const createJobId = (runId: string, nodeKey: string, attempt: number): string => {
  return `${runId}:${nodeKey}:${attempt}`;
};
