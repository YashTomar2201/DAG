/**
 * Schedule service (roadmap B2) — cron-driven runs.
 *
 * A `Schedule` row is the user-facing record; the authoritative timer is a
 * BullMQ Job Scheduler on the `scheduler` queue, kept in lock-step with the row
 * here (create → upsert job, disable/delete → remove job). The API process runs
 * a `Worker` on that queue (`scheduler-worker.ts`) that calls `fireSchedule`.
 */

import {
  createSchedule,
  listSchedulesForWorkflow,
  getScheduleById,
  updateSchedule,
  deleteSchedule,
  listEnabledSchedules,
  workflowBelongsToTenant,
  getLatestVersionId,
  findRunByIdempotencyKey,
  type Schedule,
} from '@dag/db';
import {
  assertValidCron,
  nextCronFire,
  upsertScheduleJob,
  removeScheduleJob,
  plannedFireMillis,
  InvalidCronError,
} from '@dag/queue';
import { startRun } from './orchestrator.service';
import { NotFoundError, ValidationError } from '../errors';
import { logger } from '../logger';

export interface ScheduleDto {
  id: string;
  workflowId: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  lastRunId: string | null;
  createdAt: string;
}

function toDto(s: Schedule): ScheduleDto {
  return {
    id: s.id,
    workflowId: s.workflowId,
    cron: s.cron,
    timezone: s.timezone,
    enabled: s.enabled,
    nextFireAt: s.nextFireAt?.toISOString() ?? null,
    lastFiredAt: s.lastFiredAt?.toISOString() ?? null,
    lastRunId: s.lastRunId,
    createdAt: s.createdAt.toISOString(),
  };
}

function validateCronOrThrow(cron: string, timezone: string) {
  try {
    assertValidCron(cron, timezone);
  } catch (err) {
    if (err instanceof InvalidCronError) throw new ValidationError(err.message);
    throw err;
  }
}

async function assertWorkflowRunnable(workflowId: string, tenantId: string) {
  if (!(await workflowBelongsToTenant(workflowId, tenantId))) {
    throw new NotFoundError('Workflow', workflowId);
  }
  if (!(await getLatestVersionId(workflowId, tenantId))) {
    throw new ValidationError('Save the workflow at least once before scheduling it.');
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function createScheduleService(
  workflowId: string,
  tenantId: string,
  body: { cron: string; timezone?: string },
): Promise<ScheduleDto> {
  const timezone = body.timezone ?? 'UTC';
  validateCronOrThrow(body.cron, timezone);
  await assertWorkflowRunnable(workflowId, tenantId);

  const schedule = await createSchedule({
    workflowId,
    cron: body.cron,
    timezone,
    nextFireAt: nextCronFire(body.cron, timezone),
  });
  await upsertScheduleJob(schedule.id, schedule.cron, schedule.timezone);

  logger.info({ scheduleId: schedule.id, workflowId, cron: schedule.cron }, 'Schedule created');
  return toDto(schedule);
}

export async function listSchedulesService(
  workflowId: string,
  tenantId: string,
): Promise<ScheduleDto[]> {
  if (!(await workflowBelongsToTenant(workflowId, tenantId))) {
    throw new NotFoundError('Workflow', workflowId);
  }
  const rows = await listSchedulesForWorkflow(workflowId);
  return rows.map(toDto);
}

export async function updateScheduleService(
  scheduleId: string,
  tenantId: string,
  body: { cron?: string; timezone?: string; enabled?: boolean },
): Promise<ScheduleDto> {
  const existing = await getScheduleById(scheduleId);
  if (!existing || !(await workflowBelongsToTenant(existing.workflowId, tenantId))) {
    throw new NotFoundError('Schedule', scheduleId);
  }

  const cron = body.cron ?? existing.cron;
  const timezone = body.timezone ?? existing.timezone;
  const enabled = body.enabled ?? existing.enabled;
  if (body.cron !== undefined || body.timezone !== undefined) {
    validateCronOrThrow(cron, timezone);
  }

  const updated = await updateSchedule(scheduleId, {
    cron,
    timezone,
    enabled,
    nextFireAt: enabled ? nextCronFire(cron, timezone) : null,
  });
  if (!updated) throw new NotFoundError('Schedule', scheduleId);

  if (enabled) await upsertScheduleJob(scheduleId, cron, timezone);
  else await removeScheduleJob(scheduleId);

  logger.info({ scheduleId, enabled, cron }, 'Schedule updated');
  return toDto(updated);
}

export async function deleteScheduleService(scheduleId: string, tenantId: string): Promise<void> {
  const existing = await getScheduleById(scheduleId);
  if (!existing || !(await workflowBelongsToTenant(existing.workflowId, tenantId))) {
    throw new NotFoundError('Schedule', scheduleId);
  }
  await removeScheduleJob(scheduleId);
  await deleteSchedule(scheduleId);
  logger.info({ scheduleId }, 'Schedule deleted');
}

// ─── Fire path (invoked by the scheduler Worker on every cron tick) ──────────

/**
 * Turns one cron tick into a run. Idempotent on `(scheduleId, plannedFireTime)`
 * so a stalled-job re-delivery after an API crash returns the run the first
 * attempt already created instead of starting a second one.
 */
export async function fireSchedule(
  scheduleId: string,
  jobId?: string,
): Promise<{ ran: boolean; runId?: string; deduped?: boolean }> {
  const schedule = await getScheduleById(scheduleId);
  if (!schedule) {
    // The row was deleted but its Job Scheduler outlived it — clean up.
    await removeScheduleJob(scheduleId);
    logger.warn({ scheduleId }, 'Tick for missing schedule — removed stale job scheduler');
    return { ran: false };
  }
  if (!schedule.enabled) return { ran: false };

  const versionId = await getLatestVersionId(schedule.workflowId);
  if (!versionId) {
    logger.warn(
      { scheduleId, workflowId: schedule.workflowId },
      'Schedule tick skipped — workflow has no saved version',
    );
    return { ran: false };
  }

  const plannedIso = new Date(plannedFireMillis(jobId)).toISOString();
  const idempotencyKey = `schedule:${scheduleId}:${plannedIso}`;
  const preexisting = await findRunByIdempotencyKey(idempotencyKey);
  const run = await startRun(versionId, idempotencyKey, { triggeredBy: 'schedule' });

  await updateSchedule(scheduleId, {
    lastRunId: run.id,
    lastFiredAt: new Date(),
    nextFireAt: nextCronFire(schedule.cron, schedule.timezone),
  });

  logger.info(
    { scheduleId, runId: run.id, plannedIso, deduped: !!preexisting },
    preexisting ? 'Schedule tick de-duplicated' : 'Schedule fired',
  );
  return { ran: true, runId: run.id, deduped: !!preexisting };
}

/**
 * On API boot, re-assert a Job Scheduler for every enabled schedule. Job
 * Schedulers live in Redis and survive restarts, so this is normally a no-op —
 * but it heals a state where Redis was flushed while Postgres kept the rows.
 */
export async function reconcileSchedules(): Promise<number> {
  const rows = await listEnabledSchedules();
  for (const s of rows) {
    await upsertScheduleJob(s.id, s.cron, s.timezone).catch((err) =>
      logger.error({ err, scheduleId: s.id }, 'Failed to reconcile schedule'),
    );
  }
  logger.info({ count: rows.length }, 'Reconciled schedules with BullMQ job schedulers');
  return rows.length;
}
