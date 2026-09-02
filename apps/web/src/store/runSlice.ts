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

export interface RunState {
  activeRunId: string | null;
  runStatus: string | null;
  nodeStatuses: Record<string, NodeStatus>; // keyed by nodeKey
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
  logs: [],
  runs: [],
  sseCleanup: null,

  startListening: (runId, cleanup) => {
    const { sseCleanup } = get();
    sseCleanup?.(); // close any previous stream
    set({ activeRunId: runId, runStatus: 'RUNNING', nodeStatuses: {}, logs: [], sseCleanup: cleanup });
  },

  applyEvent: (type, data) => {
    const payload = data as Record<string, unknown>;
    const nodeKey = payload['nodeKey'] as string | undefined;

    set((s) => {
      // ── Run-level events ────────────────────────────────────────────────
      if (type === 'RUN_SUCCEEDED') return { runStatus: 'SUCCEEDED' };
      if (type === 'RUN_FAILED')    return { runStatus: 'FAILED' };
      if (type === 'RUN_CANCELLED') return { runStatus: 'CANCELLED' };

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

  stopListening: () => {
    get().sseCleanup?.();
    set({ sseCleanup: null });
  },

  clearLogs: () => set({ logs: [] }),
}));
