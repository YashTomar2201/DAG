import { z } from 'zod';

// ─── NodeRun state machine (PROJECT_GUIDE.md §5) ───────────────────────────
// PENDING → QUEUED → RUNNING → SUCCEEDED
//    │         │        │
//    │         │        ├──► FAILED (attempts exhausted / unrecoverable)
//    │         │        └──► QUEUED  (retry, attempt++)
//    │         └──────────── CANCELLED
//    └──────────────────────► SKIPPED (an ancestor FAILED)
//
// Terminal states: SUCCEEDED | FAILED | SKIPPED | CANCELLED
// Every status write must be guarded on the expected prior state (conditional UPDATE).

export const NodeStatusSchema = z.enum([
  'PENDING',
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
]);

export type NodeStatus = z.infer<typeof NodeStatusSchema>;

/** States from which a NodeRun can never transition out */
export const TERMINAL_NODE_STATUSES: ReadonlySet<NodeStatus> = new Set([
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
]);

// ─── Run status ─────────────────────────────────────────────────────────────
// A Run is the execution of one WorkflowVersion.
// Terminal when all its NodeRuns are terminal.

export const RunStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);
