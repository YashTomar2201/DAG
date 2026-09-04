import { Router, type Router as ExpressRouter } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate';
import {
  getRunService,
  cancelRunService,
  retryFailedNodesService,
  listRunChildrenService,
} from '../services/run.service';
import { streamRunEvents } from '../services/sse.service';
import { startRun } from '../services/orchestrator.service';
import { resolveArtifactDownload } from '../services/artifact-download.service';
import { logger } from '../logger';

export const runRouter: ExpressRouter = Router();

// ─── POST /runs ───────────────────────────────────────────────────────────────

const StartRunBody = z.object({
  workflowVersionId: z.string().min(1),
  idempotencyKey: z.string().optional(),
});

/**
 * Starts a new run for a specific workflow version.
 */
runRouter.post('/', validateBody(StartRunBody), async (req, res, next) => {
  try {
    const { workflowVersionId, idempotencyKey } = req.body;
    const run = await startRun(workflowVersionId, idempotencyKey);
    res.status(201).json(run);
  } catch (err) {
    next(err);
  }
});

// ─── GET /runs/:id ────────────────────────────────────────────────────────────

/**
 * Returns a Run with all its NodeRuns and timing information.
 * Used by the frontend to render the run detail / Gantt view.
 */
runRouter.get('/:id', async (req, res, next) => {
  try {
    const run = await getRunService(req.params['id'] as string);
    res.json(run);
  } catch (err) {
    next(err);
  }
});

// ─── GET /runs/:id/children ──────────────────────────────────────────────────

/**
 * Paginated list of a run's fan-out children (roadmap B3), ordered by
 * `fanOutIndex`. Response: { children: [...], nextCursor: string | null }.
 */
const ChildrenQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
});

runRouter.get('/:id/children', async (req, res, next) => {
  try {
    const q = ChildrenQuery.parse(req.query);
    const result = await listRunChildrenService(req.params['id'] as string, q);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── GET /runs/:id/events ─────────────────────────────────────────────────────

/**
 * Server-Sent Events stream for live run status updates. Phase 10.
 *
 * Protocol:
 *   1. Replays all persisted events since `Last-Event-ID` (exactly-once replay).
 *   2. Switches to live Redis pub/sub for future events.
 *   3. Sends SSE heartbeat comments every 15 s.
 *   4. Cleans up the Redis subscription on client disconnect.
 *
 * Reconnection: browsers send `Last-Event-ID` header automatically.
 * `curl -N --header 'Last-Event-ID: 42' /runs/:id/events` to test.
 */
runRouter.get('/:id/events', async (req, res, next) => {
  try {
    const runId = req.params['id'] as string;
    const lastEventId = req.headers['last-event-id'] as string | undefined;
    // streamRunEvents sets SSE headers, replays history, and holds the connection
    await streamRunEvents(runId, res, lastEventId);
  } catch (err) {
    next(err);
  }
});

// ─── GET /runs/:id/nodes/:nodeKey/artifacts/:field/download ──────────────────

/**
 * Downloads one artifact referenced by a NodeRun's output (roadmap C1.2),
 * e.g. `GET /runs/abc/nodes/train/artifacts/weightsPath/download`.
 * `ARTIFACT_BACKEND=s3` redirects to a 15-minute presigned URL;
 * `ARTIFACT_BACKEND=fs` streams the file directly.
 */
runRouter.get('/:id/nodes/:nodeKey/artifacts/:field/download', async (req, res, next) => {
  try {
    const { id: runId, nodeKey, field } = req.params as { id: string; nodeKey: string; field: string };
    const download = await resolveArtifactDownload(runId, nodeKey, field);
    if (download.kind === 'redirect') {
      res.redirect(download.url);
    } else {
      res.download(download.absolutePath, download.filename);
    }
  } catch (err) {
    next(err);
  }
});

// ─── POST /runs/:id/cancel ────────────────────────────────────────────────────

/**
 * Cancels a run and its fan-out child-run subtree: drains queued BullMQ jobs,
 * flips every non-terminal NodeRun to CANCELLED, and sets a Redis flag so a
 * worker already running a node aborts its Python child within ~15 s
 * (roadmap B4). See `cancel.service.ts`.
 */
runRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const runId = req.params['id'] as string;
    const result = await cancelRunService(runId);
    logger.info({ runId, ...result }, 'Run cancel requested');
    res.json({ runId, ...result });
  } catch (err) {
    next(err);
  }
});

// ─── POST /runs/:id/retry-failed ─────────────────────────────────────────────

/**
 * Re-dispatches all FAILED nodes and resets SKIPPED descendants to PENDING.
 * Only works on runs with status === 'FAILED'.
 * The orchestrator's QueueEvents listener will pick up newly-PENDING nodes
 * once the worker reports them queued.
 */
runRouter.post('/:id/retry-failed', async (req, res, next) => {
  try {
    const runId = req.params['id'] as string;
    const result = await retryFailedNodesService(runId);
    logger.info({ runId, ...result }, 'Retry-failed requested');
    res.json({ runId, ...result });
  } catch (err) {
    next(err);
  }
});
