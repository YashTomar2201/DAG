import { Router, type Router as ExpressRouter } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate';
import { tenantOf } from './tenant';
import {
  createTriggerService,
  listTriggersService,
  setTriggerEnabledService,
  deleteTriggerService,
  handleWebhookService,
  SIGNATURE_HEADER,
} from '../services/trigger.service';
import { logger } from '../logger';

export const triggerRouter: ExpressRouter = Router();

const UpdateTriggerBody = z.object({ enabled: z.boolean() });

// ─── GET /workflows/:id/triggers ─────────────────────────────────────────────

triggerRouter.get('/workflows/:id/triggers', async (req, res, next) => {
  try {
    const triggers = await listTriggersService(req.params['id'] as string, tenantOf(req));
    res.json({ triggers });
  } catch (err) {
    next(err);
  }
});

// ─── POST /workflows/:id/triggers ────────────────────────────────────────────

/** Creates a webhook. The `secret` is in the 201 body — the only time it is shown. */
triggerRouter.post('/workflows/:id/triggers', async (req, res, next) => {
  try {
    const trigger = await createTriggerService(req.params['id'] as string, tenantOf(req));
    res.status(201).json(trigger);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /triggers/:triggerId ──────────────────────────────────────────────

triggerRouter.patch(
  '/triggers/:triggerId',
  validateBody(UpdateTriggerBody),
  async (req, res, next) => {
    try {
      const trigger = await setTriggerEnabledService(
        req.params['triggerId'] as string,
        tenantOf(req),
        req.body.enabled,
      );
      res.json(trigger);
    } catch (err) {
      next(err);
    }
  },
);

// ─── DELETE /triggers/:triggerId ─────────────────────────────────────────────

triggerRouter.delete('/triggers/:triggerId', async (req, res, next) => {
  try {
    await deleteTriggerService(req.params['triggerId'] as string, tenantOf(req));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ─── POST /triggers/:token  (the webhook itself) ─────────────────────────────

/**
 * The request body arrives as a raw Buffer (see the `express.raw` mount in
 * app.ts) so the HMAC is verified over the exact bytes the caller signed.
 */
triggerRouter.post('/triggers/:token', async (req, res, next) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const signature = req.header(SIGNATURE_HEADER) ?? undefined;
    const result = await handleWebhookService(req.params['token'] as string, raw, signature);
    logger.info({ token: req.params['token'], ...result }, 'Webhook delivery');
    res.status(result.deduped ? 200 : 202).json(result);
  } catch (err) {
    next(err);
  }
});
