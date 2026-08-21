import { Router, type Router as ExpressRouter } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate';
import {
  createWorkflowService,
  createVersionService,
  validateGraphService,
} from '../services/workflow.service';
import { logger } from '../logger';

export const workflowRouter: ExpressRouter = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const CreateWorkflowBody = z.object({
  tenantId: z.string().min(1),
  name: z.string().min(1).max(255),
  graph: z.unknown(), // validated inside the service against GraphSchema
});

const CreateVersionBody = z.object({
  graph: z.unknown(),
});

const ValidateGraphBody = z.object({
  graph: z.unknown(),
});

// ─── POST /workflows ──────────────────────────────────────────────────────────

/**
 * Creates a new Workflow with its first WorkflowVersion.
 * Returns 201 with { workflowId, versionId }.
 * Returns 422 if the graph contains a cycle (body: { cyclePath }).
 * Returns 400 if the graph schema is invalid (body: { issues }).
 */
workflowRouter.post(
  '/',
  validateBody(CreateWorkflowBody),
  async (req, res, next) => {
    try {
      const result = await createWorkflowService(req.body);
      logger.info({ workflowId: result.workflowId, versionId: result.versionId }, 'Workflow created');
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /workflows/:id/versions ────────────────────────────────────────────

/**
 * Appends a new immutable version to an existing workflow.
 * The graph is validated (schema + cycle detection) and the topoOrder is
 * computed and cached on the version row before returning.
 *
 * Returns 201 with the new WorkflowVersion row.
 * Returns 422 with { cyclePath } if a cycle is detected.
 * Returns 404 if the workflow doesn't exist.
 */
workflowRouter.post(
  '/:id/versions',
  validateBody(CreateVersionBody),
  async (req, res, next) => {
    try {
      const version = await createVersionService({
        workflowId: req.params['id'] as string,
        graph: req.body.graph,
      });
      logger.info(
        { workflowId: req.params['id'], versionId: version.id, version: version.version },
        'Workflow version created',
      );
      res.status(201).json(version);
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /workflows/:id/validate ─────────────────────────────────────────────

/**
 * Dry-run validation — validates the graph without persisting anything.
 * Used by the editor for live feedback as the user draws edges.
 *
 * Always returns 200; the `valid` field in the body indicates success/failure.
 * This is intentional — the client needs the detailed error payload regardless.
 */
workflowRouter.post(
  '/:id/validate',
  validateBody(ValidateGraphBody),
  (req, res) => {
    const result = validateGraphService(req.body.graph);
    res.status(200).json(result);
  },
);
