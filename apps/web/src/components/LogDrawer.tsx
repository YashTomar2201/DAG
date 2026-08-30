/**
 * Log Drawer — shows streaming worker stdout for the selected node during a run.
 */

import { useRunStore } from '../store/runSlice';
import { useGraphStore } from '../store/graphSlice';
import { useEffect, useRef } from 'react';

export function LogDrawer() {
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const logs = useRunStore((s) => s.logs);
  const clearLogs = useRunStore((s) => s.clearLogs);
  const bottomRef = useRef<HTMLDivElement>(null);

  const nodeLogs = selectedNodeId
    ? logs.filter((l) => l.nodeKey === selectedNodeId)
    : logs;

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [nodeLogs.length]);

  if (nodeLogs.length === 0) return null;

  return (
    <div style={{
      position: 'absolute',
      bottom: 24,
      left: 'calc(24px + var(--spacing-md))',
      right: 'calc(24px + var(--spacing-md))',
      height: 240,
      background: 'var(--color-surface-dark)',
      border: '1px solid var(--color-surface-dark-elevated)',
      borderRadius: 'var(--radius-lg)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 10,
      boxShadow: '0 -4px 20px rgba(0,0,0,0.2)',
      overflow: 'hidden'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 16px',
        background: 'var(--color-surface-dark-soft)',
        borderBottom: '1px solid var(--color-surface-dark-elevated)',
        color: 'var(--color-on-dark-soft)',
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.05em',
      }}>
        <span className="caption-uppercase">Logs {selectedNodeId ? `— ${selectedNodeId}` : '(all nodes)'}</span>
        <button
          onClick={clearLogs}
          style={{ background: 'none', border: 'none', color: 'var(--color-on-dark-soft)', cursor: 'pointer', fontSize: 11, opacity: 0.7 }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
        >
          Clear
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {nodeLogs.map((l, i) => (
          <div key={i} className="code" style={{
            color: 'var(--color-on-dark-soft)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            marginBottom: 4
          }}>
            <span style={{ color: 'var(--color-muted-soft)', marginRight: 12, opacity: 0.5 }}>
              {new Date(l.ts).toISOString().substring(11, 23)}
            </span>
            {l.line}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
