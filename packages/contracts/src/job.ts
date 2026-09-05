import { z } from 'zod';
import { NODE_TYPES } from './node-types';

// ─── Job payload — what goes onto the Redis / BullMQ queue ─────────────────
// The worker receives this payload and uses it to:
//   1. Look up the executor by `type`
//   2. Pass `config` + `input` to the executor
//   3. Report back with `nodeRunId` so the control plane updates the right row

export const JobPayloadSchema = z.object({
  runId: z.string().cuid(),
  nodeKey: z.string().min(1),
  nodeRunId: z.string().cuid(),
  /** The tenant that owns this run — RLS (roadmap C2.1) requires it for every DB call the worker makes. */
  tenantId: z.string().min(1),
  /**
   * The node type determines which executor handles this job.
   * Inferred from the NodeDef's discriminated union — the worker's switch/map
   * is exhaustive at compile time.
   */
  type: z.enum(NODE_TYPES),
  /** Fully typed config from the NodeDef, forwarded as-is */
  config: z.record(z.unknown()),
  /**
   * Resolved inputs from parent NodeRun outputs.
   * Template interpolation (`{{ nodes.x.output.y }}`) has already been done
   * by the control plane at dispatch time — workers receive literal values only.
   */
  input: z.record(z.unknown()).nullable(),
  /** Current attempt number (1-indexed). Incremented on each retry. */
  attempt: z.number().int().min(1),
  /**
   * Backoff ceiling in ms from the node's `retryPolicy.cap` (roadmap B5). The
   * BullMQ custom backoff strategy reads this off `job.data` — `job.opts` only
   * carries the base delay.
   */
  retryCap: z.number().int().positive().optional(),
});

export type JobPayload = z.infer<typeof JobPayloadSchema>;
