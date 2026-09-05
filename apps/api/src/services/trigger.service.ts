/**
 * Webhook trigger service (roadmap B2).
 *
 * `POST /triggers/:token` with a valid `X-Signature-256: sha256=<hmac>` header
 * (HMAC-SHA256 of the raw request body, keyed by the trigger's secret) starts a
 * run of the workflow's latest version. The run's idempotency key embeds
 * `sha256(rawBody)`, so re-POSTing the exact same body returns the first run
 * rather than starting another — replays are rejected for free.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import {
  createTrigger,
  listTriggersForWorkflow,
  getTriggerByToken,
  getTriggerById,
  updateTrigger,
  deleteTrigger,
  workflowBelongsToTenant,
  getLatestVersionId,
  getWorkflowTenantId,
  findRunByIdempotencyKey,
  type Trigger,
} from '@dag/db';
import { startRun } from './orchestrator.service';
import { NotFoundError, ValidationError, UnauthorizedError } from '../errors';
import { logger } from '../logger';

/** Header the caller must send: `X-Signature-256: sha256=<hex>`. */
export const SIGNATURE_HEADER = 'x-signature-256';

export interface TriggerDto {
  id: string;
  workflowId: string;
  token: string;
  webhookPath: string;
  enabled: boolean;
  lastFiredAt: string | null;
  lastRunId: string | null;
  createdAt: string;
}

function toDto(t: Trigger): TriggerDto {
  return {
    id: t.id,
    workflowId: t.workflowId,
    token: t.token,
    webhookPath: `/triggers/${t.token}`,
    enabled: t.enabled,
    lastFiredAt: t.lastFiredAt?.toISOString() ?? null,
    lastRunId: t.lastRunId,
    createdAt: t.createdAt.toISOString(),
  };
}

/** `sha256=<hex>` HMAC of `body` under `secret` — the value we expect in the header. */
export function signBody(secret: string, body: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ─── Management ─────────────────────────────────────────────────────────────

/** Creates a trigger. The `secret` is returned ONLY here — it is never listed again. */
export async function createTriggerService(
  workflowId: string,
  tenantId: string,
): Promise<TriggerDto & { secret: string }> {
  if (!(await workflowBelongsToTenant(workflowId, tenantId))) {
    throw new NotFoundError('Workflow', workflowId);
  }
  if (!(await getLatestVersionId(workflowId, tenantId))) {
    throw new ValidationError('Save the workflow at least once before adding a webhook.');
  }
  const token = randomBytes(18).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  const trigger = await createTrigger({ workflowId, token, secret });
  logger.info({ triggerId: trigger.id, workflowId }, 'Trigger created');
  return { ...toDto(trigger), secret };
}

export async function listTriggersService(
  workflowId: string,
  tenantId: string,
): Promise<TriggerDto[]> {
  if (!(await workflowBelongsToTenant(workflowId, tenantId))) {
    throw new NotFoundError('Workflow', workflowId);
  }
  const rows = await listTriggersForWorkflow(workflowId);
  return rows.map(toDto);
}

export async function setTriggerEnabledService(
  triggerId: string,
  tenantId: string,
  enabled: boolean,
): Promise<TriggerDto> {
  const existing = await getTriggerById(triggerId);
  if (!existing || !(await workflowBelongsToTenant(existing.workflowId, tenantId))) {
    throw new NotFoundError('Trigger', triggerId);
  }
  const updated = await updateTrigger(triggerId, { enabled });
  logger.info({ triggerId, enabled }, 'Trigger updated');
  return toDto(updated!);
}

export async function deleteTriggerService(triggerId: string, tenantId: string): Promise<void> {
  const existing = await getTriggerById(triggerId);
  if (!existing || !(await workflowBelongsToTenant(existing.workflowId, tenantId))) {
    throw new NotFoundError('Trigger', triggerId);
  }
  await deleteTrigger(triggerId);
  logger.info({ triggerId }, 'Trigger deleted');
}

// ─── Webhook delivery ──────────────────────────────────────────────────────

export async function handleWebhookService(
  token: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): Promise<{ runId: string; status: string; deduped: boolean }> {
  const trigger = await getTriggerByToken(token);
  // A disabled or unknown token is indistinguishable to the caller — 404 either way.
  if (!trigger || !trigger.enabled) throw new NotFoundError('Trigger', token);

  if (!signatureHeader) throw new UnauthorizedError('Missing X-Signature-256 header');
  const expected = signBody(trigger.secret, rawBody);
  if (!safeEqual(expected, signatureHeader.trim())) {
    throw new UnauthorizedError('Signature does not match request body');
  }

  // No authenticated request behind a webhook delivery — resolve the owning
  // tenant first (admin context; roadmap C2.1) before any RLS-protected lookup.
  const tenantId = await getWorkflowTenantId(trigger.workflowId);
  if (!tenantId) throw new NotFoundError('Trigger', token);

  const versionId = await getLatestVersionId(trigger.workflowId, tenantId);
  if (!versionId) throw new ValidationError('This workflow has no saved version to run.');

  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const idempotencyKey = `webhook:${trigger.id}:${bodyHash}`;
  const preexisting = await findRunByIdempotencyKey(idempotencyKey, tenantId);
  const run = await startRun(versionId, idempotencyKey, { triggeredBy: 'webhook', tenantId });

  await updateTrigger(trigger.id, { lastRunId: run.id, lastFiredAt: new Date() });

  logger.info(
    { triggerId: trigger.id, runId: run.id, deduped: !!preexisting },
    preexisting ? 'Webhook replay de-duplicated' : 'Webhook fired',
  );
  return { runId: run.id, status: run.status, deduped: !!preexisting };
}
