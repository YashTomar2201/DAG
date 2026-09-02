/**
 * Run History Panel.
 * Displays a list of past runs for the active workflow and a Gantt chart for the selected run.
 *
 * NOTE: There is no GET /workflows/:id/runs endpoint on the API.
 * Runs are tracked in the Zustand runSlice as they are created — each call to
 * handleRun in App.tsx pushes the new RunRecord into the store via setRuns.
 * For the Gantt chart we fetch the full run (with nodeRuns) from GET /runs/:id
 * only when the user clicks to expand a run row.
 */

import { useEffect, useState } from 'react';
import { useRunStore } from '../store/runSlice';
import { useGraphStore } from '../store/graphSlice';
import { getRun, retryFailed, type RunSummary } from '../api/client';
import { GanttChart } from './GanttChart';
import { IconHistory, IconClose, IconRetry } from './icons';

const STATUS_COLOR: Record<string, string> = {
  SUCCEEDED: 'var(--color-success)',
  FAILED: 'var(--color-error)',
  RUNNING: 'var(--color-warning)',
  CANCELLED: 'var(--color-muted-soft)',
};

/** The Run row has no `createdAt` column — fall back through the timestamps we do get. */
function formatRunTime(ts: string | null | undefined): string {
  if (!ts) return 'Just now';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? 'Just now' : d.toLocaleString();
}

export function RunHistory({ workflowId }: { workflowId: string | null }) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedRun, setSelectedRun] = useState<RunSummary | null>(null);
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null);

  const runs = useRunStore(s => s.runs);
  const upsertRun = useRunStore(s => s.upsertRun);
  const activeRunId = useRunStore(s => s.activeRunId);

  // Map of node key → human label, so the Gantt chart can show "Train model"
  // instead of the opaque "node-3".
  const nodeLabels = useGraphStore(s =>
    Object.fromEntries(s.nodes.map(n => [n.id, n.data.label])),
  );

  // When a new active run ends (status becomes terminal), refresh its full detail
  // so the Gantt chart shows timing even for the just-completed run.
  const runStatus = useRunStore(s => s.runStatus);
  useEffect(() => {
    if (activeRunId && (runStatus === 'SUCCEEDED' || runStatus === 'FAILED' || runStatus === 'CANCELLED')) {
      getRun(activeRunId).then((fullRun) => {
        // Replace the RunRecord in the store with the full RunSummary (in place,
        // reading current store state — not a stale closure over `runs`).
        upsertRun(fullRun as unknown as (typeof runs)[number]);
        setSelectedRun(prev => (prev?.id === activeRunId ? fullRun : prev));
      }).catch(console.error);
    }
    // getRun / upsertRun / setSelectedRun are stable; run status + id are the real triggers.
  }, [runStatus, activeRunId]);

  async function handleSelectRun(runId: string) {
    // If we already have full data (with nodeRuns), just show it
    const existing = runs.find(r => r.id === runId) as RunSummary | undefined;
    if (existing && 'nodeRuns' in existing && existing.nodeRuns) {
      setSelectedRun(existing);
      return;
    }
    // Otherwise fetch the full run detail
    setLoadingRunId(runId);
    try {
      const full = await getRun(runId);
      setSelectedRun(full);
    } catch (e) {
      console.error('Failed to load run detail:', e);
    } finally {
      setLoadingRunId(null);
    }
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="btn-secondary"
        style={{
          position: 'absolute',
          top: 20,
          right: 20,
          zIndex: 10,
          fontSize: 13,
          background: 'var(--color-canvas)',
          boxShadow: '0 4px 14px rgba(20,20,19,0.12)',
        }}
      >
        <IconHistory size={15} />
        Run history{runs.length > 0 ? ` · ${runs.length}` : ''}
      </button>
    );
  }

  return (
    <div className="animate-in" style={{
      position: 'absolute',
      top: 20,
      right: 20,
      width: 400,
      maxHeight: 'calc(100% - 40px)',
      background: 'var(--color-canvas)',
      border: '1px solid var(--color-hairline)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: '0 16px 44px rgba(20,20,19,0.16)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 10,
      overflow: 'hidden'
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 16px 14px 20px',
        borderBottom: '1px solid var(--color-hairline)',
        background: 'var(--color-canvas)'
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--color-ink)', fontWeight: 600, fontSize: 15 }}>
          <IconHistory size={16} />
          Run history
        </span>
        <button className="btn-ghost" onClick={() => setIsOpen(false)} aria-label="Close">
          <IconClose size={15} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        {!workflowId ? (
          <div className="body-md" style={{ color: 'var(--color-muted)', textAlign: 'center', padding: 32 }}>
            Save the workflow first to see runs.
          </div>
        ) : runs.length === 0 ? (
          <div className="body-md" style={{ color: 'var(--color-muted)', textAlign: 'center', padding: 32 }}>
            No runs yet. Hit <strong>Run pipeline</strong> to start one.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[...runs].reverse().map(run => (
              <div
                key={run.id}
                style={{
                  padding: '16px',
                  background: selectedRun?.id === run.id ? 'var(--color-surface-card)' : 'transparent',
                  border: `1px solid ${selectedRun?.id === run.id ? 'var(--color-primary)' : 'var(--color-hairline)'}`,
                  borderRadius: 'var(--radius-lg)',
                  cursor: loadingRunId === run.id ? 'wait' : 'pointer',
                  transition: 'all 0.2s',
                  opacity: loadingRunId === run.id ? 0.7 : 1,
                }}
                onClick={() => handleSelectRun(run.id)}
                onMouseEnter={(e) => {
                  if (selectedRun?.id !== run.id) {
                    (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-soft)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedRun?.id !== run.id) {
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
                  }
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span className="body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                    {formatRunTime(run.startedAt ?? run.createdAt)}
                  </span>
                  <span style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.03em',
                    color: STATUS_COLOR[run.status] ?? 'var(--color-muted)',
                  }}>
                    <span style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: STATUS_COLOR[run.status] ?? 'var(--color-muted)',
                      animation: run.id === activeRunId && run.status === 'RUNNING' ? 'pulse 1.2s ease-in-out infinite' : 'none',
                    }} />
                    {run.status}{run.id === activeRunId ? ' · live' : ''}
                  </span>
                </div>

                {selectedRun?.id === run.id && (
                  <div style={{ marginTop: 12, padding: '12px', background: 'var(--color-surface-dark)', borderRadius: 'var(--radius-md)' }}>
                    {'nodeRuns' in selectedRun && selectedRun.nodeRuns ? (
                      <>
                        <GanttChart nodeRuns={selectedRun.nodeRuns} nodeLabels={nodeLabels} />
                        {selectedRun.status === 'FAILED' && (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              await retryFailed(run.id);
                              // Refresh run detail after retry
                              const updated = await getRun(run.id);
                              setSelectedRun(updated);
                            }}
                            className="btn-primary"
                            style={{ marginTop: 12, width: '100%', fontSize: 12, height: 34 }}
                          >
                            <IconRetry size={14} />
                            Retry failed nodes
                          </button>
                        )}
                      </>
                    ) : (
                      <div style={{ color: 'var(--color-on-dark-soft)', fontSize: 12, textAlign: 'center' }}>
                        {loadingRunId === run.id ? 'Loading…' : 'Click to load details'}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
