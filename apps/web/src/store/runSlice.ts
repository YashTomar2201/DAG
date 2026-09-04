/**
 * runSlice — owns live run state.
 *
 * Separated from graphSlice because run state changes at very high frequency
 * (SSE events arrive continuously during a run) while graph state is static
 * during execution. Keeping them in separate Zustand stores means a status
 * update on node "train" only re-renders components subscribed to runSlice.
 */

import { create } from 'zustand';
import type { RunRecord } from '../api/client';

export interface NodeStatus {
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempt: number;
  error: unknown;
}

export interface LogLine {
  nodeKey: string;
  line: string;
  ts: number;
}

/** Live fan-out progress for one `flow.map` node (roadmap B3.5). */
export interface FanOutProgress {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  /** succeeded + failed + cancelled */
  done: number;
}

export interface RunState {
  activeRunId: string | null;
  runStatus: string | null;
  nodeStatuses: Record<string, NodeStatus>; // keyed by nodeKey
  fanOut: Record<string, FanOutProgress>;   // keyed by the flow.map node's key
  logs: LogLine[];
  runs: RunRecord[];       // history list — bare RunRecord; RunHistory fetches full detail on demand
  sseCleanup: (() => void) | null;

  // Actions
  startListening: (runId: string, cleanup: () => void) => void;
  applyEvent: (type: string, data: unknown) => void;
  addRun: (run: RunRecord) => void;       // push a newly-created run into history
  upsertRun: (run: RunRecord) => void;    // replace one run in place by id (or prepend if new)
  setRuns: (runs: RunRecord[]) => void;   // bulk-replace (used by RunHistory refresh)
  stopListening: () => void;
  clearLogs: () => void;
}

export const useRunStore = create<RunState>((set, get) => ({
  activeRunId: null,
  runStatus: null,
  nodeStatuses: {},
  fanOut: {},
  logs: [],
  runs: [],
  sseCleanup: null,

  startListening: (runId, cleanup) => {
    const { sseCleanup } = get();
    sseCleanup?.(); // close any previous stream
    set({ activeRunId: runId, runStatus: 'RUNNING', nodeStatuses: {}, fanOut: {}, logs: [], sseCleanup: cleanup });
  },

  applyEvent: (type, data) => {
    const payload = data as Record<string, unknown>;
    const nodeKey = payload['nodeKey'] as string | undefined;

    set((s) => {
      // ── Run-level events ────────────────────────────────────────────────
      if (type === 'RUN_SUCCEEDED') return { runStatus: 'SUCCEEDED' };
      if (type === 'RUN_FAILED')    return { runStatus: 'FAILED' };
      if (type === 'RUN_CANCELLED') return { runStatus: 'CANCELLED' };

      // ── Fan-out progress (B3.5) ────────────────────────────────────────
      if (type === 'RUN_SPAWNED') {
        const key = payload['mapNodeKey'] as string;
        const total = (payload['total'] as number) ?? 0;
        const prev = s.fanOut[key];
        return {
          fanOut: {
            ...s.fanOut,
            [key]: {
              total,
              succeeded: prev?.succeeded ?? 0,
              failed: prev?.failed ?? 0,
              cancelled: prev?.cancelled ?? 0,
              done: prev?.done ?? 0,
            },
          },
        };
      }
      if (type === 'RUN_CHILD_COMPLETED') {
        const key = payload['mapNodeKey'] as string;
        const succeeded = (payload['succeeded'] as number) ?? 0;
        const failed = (payload['failed'] as number) ?? 0;
        const cancelled = (payload['cancelled'] as number) ?? 0;
        return {
          fanOut: {
            ...s.fanOut,
            [key]: {
              total: (payload['total'] as number) ?? s.fanOut[key]?.total ?? 0,
              succeeded,
              failed,
              cancelled,
              done: succeeded + failed + cancelled,
            },
          },
        };
      }

      // ── Node-level status events ────────────────────────────────────────
      if (nodeKey && ['NODE_QUEUED','NODE_RUNNING','NODE_SUCCEEDED','NODE_FAILED','NODE_SKIPPED','NODE_CANCELLED'].includes(type)) {
        const statusMap: Record<string, string> = {
          NODE_QUEUED: 'QUEUED', NODE_RUNNING: 'RUNNING',
          NODE_SUCCEEDED: 'SUCCEEDED', NODE_FAILED: 'FAILED',
          NODE_SKIPPED: 'SKIPPED', NODE_CANCELLED: 'CANCELLED',
        };
        return {
          nodeStatuses: {
            ...s.nodeStatuses,
            [nodeKey]: {
              status: statusMap[type] ?? type,
              startedAt: (payload['startedAt'] as string) ?? s.nodeStatuses[nodeKey]?.startedAt ?? null,
              finishedAt: (payload['finishedAt'] as string) ?? null,
              attempt: (payload['attempt'] as number) ?? 1,
              error: payload['error'] ?? null,
            },
          },
        };
      }

      // ── Log events ──────────────────────────────────────────────────────
      if (type === 'NODE_LOG' && nodeKey) {
        const line = payload['line'] as string;
        const ts = (payload['ts'] as number) ?? Date.now();
        return { logs: [...s.logs.slice(-500), { nodeKey, line, ts }] };
      }
      if (type === 'NODE_LOG_BATCH') {
        const logBatch = payload['logs'] as Array<{ nodeKey?: string; payload: { line: string }; ts: number }>;
        const newLines: LogLine[] = (logBatch ?? []).map((l) => ({
          nodeKey: l.nodeKey ?? '',
          line: (l.payload?.line ?? ''),
          ts: l.ts ?? Date.now(),
        }));
        return { logs: [...s.logs.slice(-500 + newLines.length), ...newLines] };
      }

      return {};
    });
  },

  addRun: (run) => set((s) => ({ runs: [run, ...s.runs] })),

  upsertRun: (run) =>
    set((s) => {
      const idx = s.runs.findIndex((r) => r.id === run.id);
      if (idx === -1) return { runs: [run, ...s.runs] };
      const next = s.runs.slice();
      next[idx] = run;
      return { runs: next };
    }),

  setRuns: (runs) => set({ runs }),

  /**
   * Tear down the live stream and release the "a run is active" lock. Called
   * when the SSE connection dies for good — the backend run may still be going,
   * but the UI can no longer track it, so it must let the user start another.
   */
  stopListening: () => {
    get().sseCleanup?.();
    set({ sseCleanup: null, activeRunId: null, runStatus: null });
  },

  clearLogs: () => set({ logs: [] }),
}));
