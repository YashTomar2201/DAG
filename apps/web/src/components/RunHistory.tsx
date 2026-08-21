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
        style={{
          position: 'absolute',
          top: 16,
          right: 280,
          background: '#1e293b',
          color: '#f8fafc',
          border: '1px solid #334155',
          padding: '8px 12px',
          borderRadius: 6,
          cursor: 'pointer',
          zIndex: 10,
          fontSize: 13,
          fontWeight: 600
        }}
      >
        Run History
      </button>
    );
  }

  return (
    <div style={{
      position: 'absolute',
      top: 16,
      right: 280,
      width: 380,
      maxHeight: '80vh',
      background: '#0f172a',
      border: '1px solid #1e293b',
      borderRadius: 8,
      boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 10,
      overflow: 'hidden'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #1e293b', background: '#1e293b' }}>
        <span style={{ color: '#f8fafc', fontWeight: 600, fontSize: 14 }}>Run History</span>
        <button onClick={() => setIsOpen(false)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>✕</button>
      </div>
      
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {!workflowId ? (
          <div style={{ color: '#64748b', fontSize: 13, textAlign: 'center', padding: 20 }}>
            Save the workflow first to see runs.
          </div>
        ) : runs.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 13, textAlign: 'center', padding: 20 }}>
            No runs found.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {runs.map(run => (
              <div 
                key={run.id}
                style={{ 
                  padding: 10, 
                  background: selectedRun?.id === run.id ? '#1e293b' : 'transparent',
                  border: `1px solid ${selectedRun?.id === run.id ? '#3b82f6' : '#334155'}`,
                  borderRadius: 6,
                  cursor: 'pointer'
                }}
                onClick={() => setSelectedRun(run)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 500 }}>
                    {new Date(run.createdAt).toLocaleString()}
                  </span>
                  <span style={{ 
                    fontSize: 11, 
                    fontWeight: 600,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: run.status === 'SUCCEEDED' ? '#22c55e22' : run.status === 'FAILED' ? '#ef444422' : '#3b82f622',
                    color: run.status === 'SUCCEEDED' ? '#4ade80' : run.status === 'FAILED' ? '#f87171' : '#60a5fa'
                  }}>
                    {run.status}
                    {run.id === activeRunId && ' (Live)'}
                  </span>
                </div>
                
                {selectedRun?.id === run.id && (
                  <div>
                    <GanttChart nodeRuns={run.nodeRuns} />
                    {run.status === 'FAILED' && (
                      <button 
                        onClick={async (e) => {
                          e.stopPropagation();
                          await retryFailed(run.id);
                          listRuns(workflowId).then(setRuns).catch(console.error);
                        }}
                        style={{
                          marginTop: 8,
                          background: '#ef4444',
                          color: 'white',
                          border: 'none',
                          padding: '4px 8px',
                          borderRadius: 4,
                          cursor: 'pointer',
                          fontSize: 12
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
