import { Router, type Router as ExpressRouter } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate';
import { requireApiKey } from '../middleware/auth';
import { tenantOf } from './tenant';
import {
  createScheduleService,
  listSchedulesService,
  updateScheduleService,
  deleteScheduleService,
} from '../services/schedule.service';

export const scheduleRouter: ExpressRouter = Router();

// This router owns absolute paths (no shared prefix app.ts can scope a
// mount-level `requireApiKey` to — see app.ts's comment), so every route here
// requires it directly.
scheduleRouter.use(requireApiKey);

const CreateScheduleBody = z.object({
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64).optional(),
});

const UpdateScheduleBody = z
  .object({
    cron: z.string().min(1).max(120).optional(),
    timezone: z.string().min(1).max(64).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });

// ─── GET /workflows/:id/schedules ────────────────────────────────────────────

scheduleRouter.get('/workflows/:id/schedules', async (req, res, next) => {
  try {
    const schedules = await listSchedulesService(req.params['id'] as string, tenantOf(req));
    res.json({ schedules });
  } catch (err) {
    next(err);
  }
});

// ─── POST /workflows/:id/schedules ───────────────────────────────────────────

scheduleRouter.post(
  '/workflows/:id/schedules',
  validateBody(CreateScheduleBody),
  async (req, res, next) => {
    try {
      const schedule = await createScheduleService(
        req.params['id'] as string,
        tenantOf(req),
        req.body,
      );
      res.status(201).json(schedule);
    } catch (err) {
      next(err);
    }
  },
);

// ─── PATCH /schedules/:scheduleId ────────────────────────────────────────────

scheduleRouter.patch(
  '/schedules/:scheduleId',
  validateBody(UpdateScheduleBody),
  async (req, res, next) => {
    try {
      const schedule = await updateScheduleService(
        req.params['scheduleId'] as string,
        tenantOf(req),
        req.body,
      );
      res.json(schedule);
    } catch (err) {
      next(err);
    }
  },
);

// ─── DELETE /schedules/:scheduleId ───────────────────────────────────────────

scheduleRouter.delete('/schedules/:scheduleId', async (req, res, next) => {
  try {
    await deleteScheduleService(req.params['scheduleId'] as string, tenantOf(req));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
