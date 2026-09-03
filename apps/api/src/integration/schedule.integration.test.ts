/**
 * B2 — Integration: cron schedules (Testcontainers).
 *
 * Exercises the schedule service + queue layer against a real Postgres + Redis:
 *   create → a BullMQ Job Scheduler exists and nextFireAt is set
 *   invalid cron → rejected
 *   fireSchedule twice for the same planned tick → exactly ONE run (idempotent)
 *   disable → Job Scheduler removed; re-enable → back
 *   delete → Job Scheduler removed, row gone
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { hermeticPipelineGraph, seedWorkflowVersion, cleanupWorkflow } from './fixtures';
import type * as ScheduleServiceModule from '../services/schedule.service';

describe('B2 — cron schedules', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let svc: typeof ScheduleServiceModule;
  let tenantId: string;
  let workflowId: string;
  let versionId: string;

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();
    svc = await import('../services/schedule.service');
    const seeded = await seedWorkflowVersion(ctx.db.prisma, hermeticPipelineGraph(), 'b2-sched');
    tenantId = seeded.tenantId;
    workflowId = seeded.workflowId;
    versionId = seeded.versionId;
  }, 60_000);

  afterAll(async () => {
    // Best-effort: drop any Job Schedulers this test left behind.
    for (const id of await ctx.queue.listScheduleJobIds()) {
      await ctx.queue.removeScheduleJob(id).catch(() => {});
    }
    await ctx.db.prisma.schedule.deleteMany({ where: { workflowId } });
    await cleanupWorkflow(ctx.db.prisma, tenantId, workflowId);
    await teardownTestEnv(ctx);
  });

  it('rejects an invalid cron expression', async () => {
    await expect(
      svc.createScheduleService(workflowId, tenantId, { cron: 'not a cron' }),
    ).rejects.toThrow(/cron/i);
  });

  it('creates a schedule with a BullMQ Job Scheduler and a computed nextFireAt', async () => {
    const schedule = await svc.createScheduleService(workflowId, tenantId, {
      cron: '*/5 * * * *',
      timezone: 'UTC',
    });
    expect(schedule.enabled).toBe(true);
    expect(schedule.nextFireAt).not.toBeNull();
    expect(new Date(schedule.nextFireAt!).getTime()).toBeGreaterThan(Date.now());

    const jobIds = await ctx.queue.listScheduleJobIds();
    expect(jobIds).toContain(schedule.id);
  });

  it('fires idempotently — the same planned tick never starts two runs', async () => {
    const schedule = await svc.createScheduleService(workflowId, tenantId, { cron: '* * * * *' });

    // Two ticks with the SAME job id → same planned fire time → one run.
    // BullMQ names scheduler jobs `<schedulerId>:<iterationMillis>`; use a
    // realistic (near-now) millis so `plannedFireMillis` reads it verbatim.
    const tickMillis = Math.floor(Date.now() / 60_000) * 60_000;
    const tickJobId = `${schedule.id}:${tickMillis}`;
    const first = await svc.fireSchedule(schedule.id, tickJobId);
    const second = await svc.fireSchedule(schedule.id, tickJobId);

    expect(first.ran).toBe(true);
    expect(second.ran).toBe(true);
    expect(first.runId).toBe(second.runId);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);

    const runs = await ctx.db.prisma.run.findMany({ where: { workflowVersionId: versionId } });
    const scheduleRuns = runs.filter((r) => r.triggeredBy === 'schedule');
    expect(scheduleRuns).toHaveLength(1);
    expect(scheduleRuns[0]!.idempotencyKey).toBe(
      `schedule:${schedule.id}:${new Date(tickMillis).toISOString()}`,
    );

    // The row records the last fire.
    const row = await ctx.db.prisma.schedule.findUnique({ where: { id: schedule.id } });
    expect(row!.lastRunId).toBe(first.runId);
    expect(row!.lastFiredAt).not.toBeNull();
  });

  it('disabling removes the Job Scheduler; re-enabling restores it', async () => {
    const schedule = await svc.createScheduleService(workflowId, tenantId, { cron: '0 2 * * *' });
    expect(await ctx.queue.listScheduleJobIds()).toContain(schedule.id);

    const disabled = await svc.updateScheduleService(schedule.id, tenantId, { enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextFireAt).toBeNull();
    expect(await ctx.queue.listScheduleJobIds()).not.toContain(schedule.id);

    const reenabled = await svc.updateScheduleService(schedule.id, tenantId, { enabled: true });
    expect(reenabled.enabled).toBe(true);
    expect(reenabled.nextFireAt).not.toBeNull();
    expect(await ctx.queue.listScheduleJobIds()).toContain(schedule.id);
  });

  it('deleting a schedule removes its Job Scheduler and the row', async () => {
    const schedule = await svc.createScheduleService(workflowId, tenantId, { cron: '15 * * * *' });
    expect(await ctx.queue.listScheduleJobIds()).toContain(schedule.id);

    await svc.deleteScheduleService(schedule.id, tenantId);

    expect(await ctx.queue.listScheduleJobIds()).not.toContain(schedule.id);
    expect(await ctx.db.prisma.schedule.findUnique({ where: { id: schedule.id } })).toBeNull();
  });

  it('cross-tenant access is a 404', async () => {
    const schedule = await svc.createScheduleService(workflowId, tenantId, { cron: '30 * * * *' });
    await expect(svc.deleteScheduleService(schedule.id, 'someone-else')).rejects.toThrow();
    await expect(svc.listSchedulesService(workflowId, 'someone-else')).rejects.toThrow();
    await svc.deleteScheduleService(schedule.id, tenantId);
  });
});
