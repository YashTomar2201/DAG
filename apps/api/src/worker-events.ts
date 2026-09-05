import { QueueEvents } from 'bullmq';
import { connection } from '@dag/queue';
import { resolveTenantForRun } from '@dag/db';
import { onNodeSucceeded, onNodeFailed } from './services/orchestrator.service';
import { logger } from './logger';

const queues = ['io', 'cpu', 'gpu'];

export function startQueueEventListeners() {
  const listeners: QueueEvents[] = [];

  for (const q of queues) {
    const queueEvents = new QueueEvents(q, { connection });
    listeners.push(queueEvents);

    queueEvents.on('completed', async ({ jobId, returnvalue }: { jobId: string; returnvalue: unknown }) => {
      try {
        const [runId, nodeKey] = parseJobId(jobId);
        // Roadmap C2.1: BullMQ's QueueEvents carries no tenant context — only
        // Run itself knows, via an admin-context lookup (see resolveTenantForRun).
        const tenantId = await resolveTenantForRun(runId);
        if (!tenantId) {
          logger.warn({ runId, nodeKey, jobId }, 'completed event for unknown run — dropped');
          return;
        }
        logger.debug({ queue: q, runId, nodeKey }, 'Received completed event');
        await onNodeSucceeded(runId, nodeKey, tenantId, returnvalue);
      } catch (err) {
        logger.error({ err, jobId }, 'Failed to process completed event');
      }
    });

    queueEvents.on('failed', async ({ jobId, failedReason }: { jobId: string, failedReason: string }) => {
      try {
        const [runId, nodeKey] = parseJobId(jobId);
        const tenantId = await resolveTenantForRun(runId);
        if (!tenantId) {
          logger.warn({ runId, nodeKey, jobId }, 'failed event for unknown run — dropped');
          return;
        }
        logger.debug({ queue: q, runId, nodeKey, failedReason }, 'Received failed event');
        await onNodeFailed(runId, nodeKey, tenantId, { message: failedReason });
      } catch (err) {
        logger.error({ err, jobId }, 'Failed to process failed event');
      }
    });
  }

  return () => {
    Promise.all(listeners.map((l) => l.close())).catch((err) =>
      logger.error({ err }, 'Error closing queue events')
    );
  };
}

function parseJobId(jobId: string): [string, string] {
  const parts = jobId.split(':');
  if (parts.length < 3) throw new Error(`Invalid jobId format: ${jobId}`);
  // `${runId}:${nodeKey}:${attempt}`
  // RunIds might have colons? No, cuid doesn't. nodeKey shouldn't.
  // Actually, runId is first part, nodeKey is second.
  return [parts[0]!, parts[1]!];
}
