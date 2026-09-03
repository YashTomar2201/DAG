import { Queue } from 'bullmq';
import parser from 'cron-parser';
import { connection } from './redis';

/**
 * The `scheduler` queue holds one BullMQ **Job Scheduler** per enabled
 * `Schedule` row (roadmap B2). A Job Scheduler is BullMQ's cron primitive: it
 * survives API restarts, is stored in Redis (not a `setInterval`), and produces
 * exactly one delayed job per cron tick even with multiple API replicas
 * connected. The API process runs a `Worker` on this queue (see
 * `apps/api/src/scheduler-worker.ts`) that turns each tick into a `startRun`.
 *
 * We deliberately do NOT put executor work here — a tick's only job is to look
 * up the schedule and enqueue a run through the normal path.
 */
export const schedulerQueue = new Queue('scheduler', {
  connection,
  defaultJobOptions: {
    // A tick that fails should not pile up retries — the next tick will fire
    // anyway, and a duplicate fire is already de-duped by idempotency key.
    attempts: 2,
    backoff: { type: 'fixed', delay: 5_000 },
    removeOnComplete: { age: 3_600, count: 200 },
    removeOnFail: { age: 24 * 3_600 },
  },
});

/** BullMQ job name for every scheduler tick. */
export const SCHEDULE_FIRE_JOB = 'schedule.fire';

export interface ScheduleFireData {
  scheduleId: string;
}

/**
 * Creates or updates the Job Scheduler for a schedule. Keyed by `scheduleId`,
 * so calling it again after a cron edit replaces the timer in place (no
 * duplicate). Call `removeScheduleJob` when the schedule is disabled or deleted.
 */
export async function upsertScheduleJob(
  scheduleId: string,
  cron: string,
  timezone: string,
): Promise<void> {
  await schedulerQueue.upsertJobScheduler(
    scheduleId,
    { pattern: cron, tz: timezone },
    { name: SCHEDULE_FIRE_JOB, data: { scheduleId } satisfies ScheduleFireData },
  );
}

/** Removes a schedule's Job Scheduler. Safe to call when none exists. */
export async function removeScheduleJob(scheduleId: string): Promise<boolean> {
  try {
    return await schedulerQueue.removeJobScheduler(scheduleId);
  } catch {
    return false;
  }
}

/** Ids of every Job Scheduler currently registered on the `scheduler` queue. */
export async function listScheduleJobIds(): Promise<string[]> {
  const schedulers = await schedulerQueue.getJobSchedulers(0, -1, true);
  return schedulers.map((s) => s.key);
}

// ─── cron helpers (shared with the API service layer) ────────────────────────

/**
 * Validates a 5-field cron expression, throwing a readable error if it is
 * malformed. Returns nothing — call it for the throw.
 */
export function assertValidCron(cron: string, timezone = 'UTC'): void {
  try {
    parser.parseExpression(cron, { tz: timezone });
  } catch (err) {
    throw new InvalidCronError(cron, err instanceof Error ? err.message : String(err));
  }
}

/** The next fire time at or after `from` (default: now) for a cron + tz. */
export function nextCronFire(cron: string, timezone = 'UTC', from: Date = new Date()): Date {
  const it = parser.parseExpression(cron, { tz: timezone, currentDate: from });
  return it.next().toDate();
}

export class InvalidCronError extends Error {
  constructor(
    public readonly cron: string,
    public readonly detail: string,
  ) {
    super(`Invalid cron expression "${cron}": ${detail}`);
    this.name = 'InvalidCronError';
  }
}

/**
 * The planned fire time (epoch ms) a scheduler tick corresponds to, used to
 * build the run's idempotency key. BullMQ names each Job-Scheduler-produced job
 * `<schedulerId>:<iterationMillis>` (older builds prefix `repeat:`), so the
 * trailing numeric segment is the exact tick time. If that can't be parsed we
 * fall back to the current minute boundary — coarse but still stable across a
 * fast stalled-job re-delivery, which is the only realistic double-fire window.
 */
export function plannedFireMillis(jobId: string | undefined, now: number = Date.now()): number {
  if (jobId) {
    const tail = jobId.split(':').pop();
    const n = tail ? Number(tail) : NaN;
    // Sanity-bound: within ~1 day of now (guards against parsing a cuid segment).
    if (Number.isFinite(n) && Math.abs(n - now) < 86_400_000) return n;
  }
  return Math.floor(now / 60_000) * 60_000;
}
