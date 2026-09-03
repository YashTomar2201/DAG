import { Router, type Router as ExpressRouter, type Request } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate';
import {
  createWorkflowService,
  createVersionService,
  validateGraphService,
  listWorkflowsService,
  getWorkflowService,
  listWorkflowVersionsService,
  getWorkflowVersionService,
  renameWorkflowService,
  deleteWorkflowService,
} from '../services/workflow.service';
import { logger } from '../logger';

export const workflowRouter: ExpressRouter = Router();

/**
 * Tenant scoping shim. Until A3 (auth) lands, the tenant comes from a
 * `?tenantId=` query param and defaults to "default" — the single-tenant
 * editor's fixed id. A3 replaces this with `req.tenantId` from a verified key.
 */
function tenantOf(req: Request): string {
  const q = req.query['tenantId'];
  return typeof q === 'string' && q.length > 0 ? q : 'default';
}

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

const RenameWorkflowBody = z.object({
  name: z.string().min(1).max(255),
});

const ListWorkflowsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});

// ─── GET /workflows ──────────────────────────────────────────────────────────

/**
 * Paginated, tenant-scoped, newest-first list. Each row carries `versionCount`
 * and `lastRunAt`. Response: { workflows: [...], nextCursor: string | null }.
 */
workflowRouter.get('/', async (req, res, next) => {
  try {
    const q = ListWorkflowsQuery.parse(req.query);
    const result = await listWorkflowsService(tenantOf(req), q);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── GET /workflows/:id ──────────────────────────────────────────────────────

/** A single workflow with its version list (newest first). 404 if soft-deleted. */
workflowRouter.get('/:id', async (req, res, next) => {
  try {
    const wf = await getWorkflowService(req.params['id'] as string, tenantOf(req));
    res.json(wf);
  } catch (err) {
    next(err);
  }
});

// ─── GET /workflows/:id/versions ─────────────────────────────────────────────

/** Just the version list (id, version, createdAt), newest first. For D1.3. */
workflowRouter.get('/:id/versions', async (req, res, next) => {
  try {
    const versions = await listWorkflowVersionsService(req.params['id'] as string, tenantOf(req));
    res.json({ versions });
  } catch (err) {
    next(err);
  }
});

// ─── GET /workflows/:id/versions/:versionId ──────────────────────────────────

/** One full version — graph + topoOrder. Used to open a workflow in the editor. */
workflowRouter.get('/:id/versions/:versionId', async (req, res, next) => {
  try {
    const version = await getWorkflowVersionService(
      req.params['id'] as string,
      req.params['versionId'] as string,
      tenantOf(req),
    );
    res.json(version);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /workflows/:id ────────────────────────────────────────────────────

/** Rename a workflow. 404 if missing or soft-deleted. */
workflowRouter.patch('/:id', validateBody(RenameWorkflowBody), async (req, res, next) => {
  try {
    const updated = await renameWorkflowService(
      req.params['id'] as string,
      tenantOf(req),
      req.body.name,
    );
    logger.info({ workflowId: updated.id }, 'Workflow renamed');
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /workflows/:id ───────────────────────────────────────────────────

/**
 * Soft-deletes a workflow (sets `deletedAt`). It vanishes from every list/read
 * path, but its runs stay readable by id. 204 on success, 404 if there was
 * nothing to delete.
 */
workflowRouter.delete('/:id', async (req, res, next) => {
  try {
    await deleteWorkflowService(req.params['id'] as string, tenantOf(req));
    logger.info({ workflowId: req.params['id'] }, 'Workflow soft-deleted');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
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
