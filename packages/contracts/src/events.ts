import { z } from 'zod';

// ─── Run event envelope ────────────────────────────────────────────────────
// Every state transition emits one of these. The event is:
//   1. Written as a `RunEvent` row to Postgres (append-only audit log)
//   2. Published to Redis pub/sub channel `run:{runId}:events`
//   3. Streamed to the browser over SSE from `GET /runs/:id/events`
//
// The `nodeKey` field is optional: some events are run-level (e.g. RUN_STARTED)
// while others are node-level (e.g. NODE_SUCCEEDED).

export const RUN_EVENT_TYPES = [
  'RUN_STARTED',
  'RUN_SUCCEEDED',
  'RUN_FAILED',
  'RUN_CANCELLED',
  'NODE_QUEUED',
  'NODE_RUNNING',
  'NODE_SUCCEEDED',
  'NODE_FAILED',
  'NODE_SKIPPED',
  'NODE_CANCELLED',
  'NODE_LOG',       // streaming stdout chunk from a worker
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const RunEventSchema = z.object({
  runId: z.string().min(1),
  /** Present on node-level events; absent on run-level events */
  nodeKey: z.string().min(1).optional(),
  type: z.enum(RUN_EVENT_TYPES),
  /** Arbitrary JSON payload — shape depends on `type` */
  payload: z.record(z.unknown()),
  /** Unix timestamp in milliseconds — set by the emitter */
  ts: z.number().int().positive(),
});

export type RunEvent = z.infer<typeof RunEventSchema>;

// ─── Error taxonomy ────────────────────────────────────────────────────────
// Used in executor implementations (Phase 8) and fault tolerance (Phase 9).
// Defined here so contracts knows the shape; actual class implementations
// live in apps/worker.

export const ErrorTaxonomySchema = z.object({
  /**
   * retryable: transient errors (network timeout, 429, FS lock contention).
   * BullMQ will retry up to the configured attempts with exponential backoff.
   *
   * unrecoverable: permanent errors (bad credentials, SyntaxError in Python script,
   * schema validation failure). BullMQ skips remaining retries immediately —
   * burning retries on a bad-credentials error wastes time and hammers Kaggle.
   */
  taxonomy: z.enum(['retryable', 'unrecoverable']),
  message: z.string(),
  originalError: z.unknown().optional(),
});

export type ErrorTaxonomy = z.infer<typeof ErrorTaxonomySchema>;
