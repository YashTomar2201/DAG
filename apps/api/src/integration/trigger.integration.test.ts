/**
 * B2 — Integration: webhook triggers (Testcontainers).
 *
 *   create → returns a one-time secret; list never shows it
 *   missing / wrong HMAC signature → 401
 *   valid signature → a run starts (triggeredBy = 'webhook')
 *   the SAME body posted twice → ONE run (idempotent on sha256(body))
 *   a different body → a second run
 *   disabled trigger → 404
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapTestEnv, teardownTestEnv } from './test-env';
import { hermeticPipelineGraph, seedWorkflowVersion, cleanupWorkflow } from './fixtures';
import type * as TriggerServiceModule from '../services/trigger.service';

describe('B2 — webhook triggers', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>;
  let svc: typeof TriggerServiceModule;
  let tenantId: string;
  let workflowId: string;
  let versionId: string;

  beforeAll(async () => {
    ctx = await bootstrapTestEnv();
    svc = await import('../services/trigger.service');
    const seeded = await seedWorkflowVersion(ctx.db, hermeticPipelineGraph(), 'b2-trig');
    tenantId = seeded.tenantId;
    workflowId = seeded.workflowId;
    versionId = seeded.versionId;
  }, 60_000);

  afterAll(async () => {
    await ctx.db.prisma.trigger.deleteMany({ where: { workflowId } });
    await cleanupWorkflow(ctx.db, tenantId, workflowId);
    await teardownTestEnv(ctx);
  });

  const webhookRunCount = async () =>
    (
      await ctx.db.withTenant(tenantId, (tx) => tx.run.findMany({ where: { workflowVersionId: versionId } }))
    ).filter((r) => r.triggeredBy === 'webhook').length;

  it('creates a trigger, revealing the secret exactly once', async () => {
    const created = await svc.createTriggerService(workflowId, tenantId);
    expect(created.token).toBeTruthy();
    expect(created.secret).toBeTruthy();
    expect(created.webhookPath).toBe(`/triggers/${created.token}`);

    const listed = await svc.listTriggersService(workflowId, tenantId);
    const row = listed.find((t) => t.id === created.id)!;
    expect(row).toBeDefined();
    expect((row as unknown as Record<string, unknown>)['secret']).toBeUndefined();
  });

  it('rejects a missing or wrong signature with 401', async () => {
    const t = await svc.createTriggerService(workflowId, tenantId);
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));

    await expect(svc.handleWebhookService(t.token, body, undefined)).rejects.toThrow(/signature/i);
    await expect(
      svc.handleWebhookService(t.token, body, 'sha256=deadbeef'),
    ).rejects.toThrow(/signature/i);
  });

  it('starts a run for a valid signature and de-duplicates an identical replay', async () => {
    const before = await webhookRunCount();
    const t = await svc.createTriggerService(workflowId, tenantId);
    const body = Buffer.from(JSON.stringify({ event: 'push', ref: 'main' }));
    const sig = svc.signBody(t.secret, body);

    const first = await svc.handleWebhookService(t.token, body, sig);
    expect(first.deduped).toBe(false);
    expect(first.runId).toBeTruthy();

    const replay = await svc.handleWebhookService(t.token, body, sig);
    expect(replay.deduped).toBe(true);
    expect(replay.runId).toBe(first.runId);

    expect(await webhookRunCount()).toBe(before + 1);

    const run = await ctx.db.withTenant(tenantId, (tx) => tx.run.findUnique({ where: { id: first.runId } }));
    expect(run!.triggeredBy).toBe('webhook');

    // A different body is a different key → a new run.
    const body2 = Buffer.from(JSON.stringify({ event: 'push', ref: 'dev' }));
    const second = await svc.handleWebhookService(t.token, body2, svc.signBody(t.secret, body2));
    expect(second.runId).not.toBe(first.runId);
    expect(await webhookRunCount()).toBe(before + 2);

    // The trigger row records the most recent fire.
    const row = await ctx.db.prisma.trigger.findUnique({ where: { id: t.id } });
    expect(row!.lastRunId).toBe(second.runId);
  });

  it('a disabled trigger is indistinguishable from a missing one (404)', async () => {
    const t = await svc.createTriggerService(workflowId, tenantId);
    await svc.setTriggerEnabledService(t.id, tenantId, false);

    const body = Buffer.from('{}');
    await expect(
      svc.handleWebhookService(t.token, body, svc.signBody(t.secret, body)),
    ).rejects.toThrow();
  });

  it('cross-tenant management is a 404', async () => {
    const t = await svc.createTriggerService(workflowId, tenantId);
    await expect(svc.deleteTriggerService(t.id, 'someone-else')).rejects.toThrow();
    await expect(svc.listTriggersService(workflowId, 'someone-else')).rejects.toThrow();
    await svc.deleteTriggerService(t.id, tenantId);
  });
});
