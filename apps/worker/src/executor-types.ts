/**
 * Executor types — the shared context and output contract for all executors.
 *
 * Every executor receives an `ExecutorContext` and must return `ExecutorOutput`
 * (a JSON-serialisable object ≤ 64 KB per the Phase 7 contract).
 *
 * The `ExecutorRegistry` type enforces exhaustiveness: it is a `Record` keyed
 * by every member of the `NodeType` union. Adding a new node type to
 * `packages/contracts/src/node-types.ts` without adding a matching executor
 * here will produce a TypeScript compile error — the registry key set must
 * exactly match `NodeType`.
 */

import type { Job } from 'bullmq';
import type { JobPayload, NodeType } from '@dag/contracts';

export interface ExecutorContext {
  /** The resolved, literal input (already had templates substituted in Phase 7) */
  input: Record<string, unknown>;
  /** The fully-typed node config from the graph */
  config: Record<string, unknown>;
  /** `{runId}:{nodeKey}` — use this to build deterministic artifact paths */
  runId: string;
  nodeKey: string;
  /** Artifact root on the shared volume */
  artifactDir: string;
  /** The BullMQ job — used for heartbeats (`job.extendLock()`, `job.updateProgress()`) */
  job: Job<JobPayload>;
  /** Called with each stdout log line from the Python bridge */
  onLog: (line: string) => void;
}

export type ExecutorOutput = Record<string, unknown>;

export type ExecutorFn = (ctx: ExecutorContext) => Promise<ExecutorOutput>;

/**
 * The executor registry maps EVERY NodeType to its handler.
 *
 * `Record<NodeType, ExecutorFn>` is intentional (not `Partial<...>`):
 * TypeScript requires all keys to be present, so omitting any executor is a
 * compile-time error rather than a silent runtime crash.
 */
export type ExecutorRegistry = Record<NodeType, ExecutorFn>;
