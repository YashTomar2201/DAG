/**
 * Run History Panel.
 * Displays a list of past runs for the active workflow and a Gantt chart for the selected run.
 */

import { useEffect, useState } from 'react';
import { useRunStore } from '../store/runSlice';
import { listRuns, retryFailed, type RunSummary } from '../api/client';
import { GanttChart } from './GanttChart';

export function RunHistory({ workflowId }: { workflowId: string | null }) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedRun, setSelectedRun] = useState<RunSummary | null>(null);
  
  const runs = useRunStore(s => s.runs);
  const setRuns = useRunStore(s => s.setRuns);
  
  // The active run state from the store to highlight in the list
  const activeRunId = useRunStore(s => s.activeRunId);

  useEffect(() => {
    if (isOpen && workflowId) {
      listRuns(workflowId).then(setRuns).catch(console.error);
    }
  }, [isOpen, workflowId, activeRunId, setRuns]);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="btn-secondary"
        style={{
          position: 'absolute',
          top: 24,
          right: 32,
          zIndex: 10,
          fontSize: 13,
        }}
      >
        Run History
      </button>
    );
  }

  return (
    <div style={{
      position: 'absolute',
      top: 24,
      right: 32,
      width: 400,
      maxHeight: '80vh',
      background: 'var(--color-canvas)',
      border: '1px solid var(--color-hairline)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: '0 12px 32px rgba(20,20,19,0.1)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 10,
      overflow: 'hidden'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '16px 24px',
        borderBottom: '1px solid var(--color-hairline)',
        background: 'var(--color-canvas)'
      }}>
        <span className="title-md" style={{ color: 'var(--color-ink)' }}>Run History</span>
        <button onClick={() => setIsOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', fontSize: 16 }}>✕</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        {!workflowId ? (
          <div className="body-md" style={{ color: 'var(--color-muted)', textAlign: 'center', padding: 32 }}>
            Save the workflow first to see runs.
          </div>
        ) : runs.length === 0 ? (
          <div className="body-md" style={{ color: 'var(--color-muted)', textAlign: 'center', padding: 32 }}>
            No runs found.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {runs.map(run => (
              <div
                key={run.id}
                style={{
                  padding: '16px',
                  background: selectedRun?.id === run.id ? 'var(--color-surface-card)' : 'transparent',
                  border: `1px solid ${selectedRun?.id === run.id ? 'var(--color-primary)' : 'var(--color-hairline)'}`,
                  borderRadius: 'var(--radius-lg)',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
                onClick={() => setSelectedRun(run)}
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
                    {new Date(run.createdAt).toLocaleString()}
                  </span>
                  <span style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-pill)',
                    background: run.status === 'SUCCEEDED' ? 'var(--color-success)' : run.status === 'FAILED' ? 'var(--color-error)' : 'var(--color-primary)',
                    color: 'var(--color-on-primary)'
                  }}>
                    {run.status}
                    {run.id === activeRunId && ' (Live)'}
                  </span>
                </div>

                {selectedRun?.id === run.id && (
                  <div style={{ marginTop: 12, padding: '12px', background: 'var(--color-surface-dark)', borderRadius: 'var(--radius-md)' }}>
                    <GanttChart nodeRuns={run.nodeRuns} />
                    {run.status === 'FAILED' && (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          await retryFailed(run.id);
                          listRuns(workflowId).then(setRuns).catch(console.error);
                        }}
                        className="btn-primary"
                        style={{
                          marginTop: 12,
                          width: '100%',
                          fontSize: 12,
                          height: 32
                        }}
                      >
                        Retry Failed Nodes
                      </button>
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
