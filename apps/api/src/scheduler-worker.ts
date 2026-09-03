/**
 * BullMQ Worker for the `scheduler` queue (roadmap B2).
 *
 * Runs inside the API process — a cron tick's only work is a DB lookup plus a
 * `startRun`, which is control-plane work, not executor work. Started from
 * `index.ts` (never from `createApp`, so integration tests that build an app
 * don't spin a timer). Each tick is idempotent on the planned fire time.
 */

import { Worker, type Job } from 'bullmq';
import { connection, SCHEDULE_FIRE_JOB, type ScheduleFireData } from '@dag/queue';
import { fireSchedule, reconcileSchedules } from './services/schedule.service';
import { logger } from './logger';

export function startSchedulerWorker(): () => Promise<void> {
  // Re-assert Job Schedulers for every enabled row (heals a flushed Redis).
  void reconcileSchedules().catch((err) =>
    logger.error({ err }, 'Schedule reconciliation failed on boot'),
  );

  const worker = new Worker(
    'scheduler',
    async (job: Job<ScheduleFireData>) => {
      if (job.name !== SCHEDULE_FIRE_JOB) return;
      return fireSchedule(job.data.scheduleId, job.id);
    },
    { connection, concurrency: 4 },
  );

  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, scheduleId: job?.data?.scheduleId, err }, 'Scheduler tick failed'),
  );
  worker.on('ready', () => logger.info('Scheduler worker ready'));

  return async () => {
    await worker.close();
  };
}
