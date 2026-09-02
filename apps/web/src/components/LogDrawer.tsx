/**
 * Log Drawer — shows streaming worker stdout for the selected node during a run.
 */

import { useRunStore } from '../store/runSlice';
import { useGraphStore } from '../store/graphSlice';
import { useEffect, useRef } from 'react';

export function LogDrawer() {
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const selectedNodeLabel = useGraphStore((s) =>
    s.nodes.find((n) => n.id === s.selectedNodeId)?.data.label ?? s.selectedNodeId,
  );
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
    <div className="animate-in" style={{
      position: 'absolute',
      bottom: 32,
      left: 32,
      right: 32,
      height: 224,
      background: 'var(--color-surface-dark)',
      border: '1px solid var(--color-surface-dark-elevated)',
      borderRadius: 'var(--radius-lg)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 10,
      boxShadow: '0 12px 32px rgba(0,0,0,0.32)',
      overflow: 'hidden'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '9px 14px',
        background: 'var(--color-surface-dark-soft)',
        borderBottom: '1px solid var(--color-surface-dark-elevated)',
        color: 'var(--color-on-dark-soft)',
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'flex', gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#e05c4a' }} />
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#e8b23c' }} />
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#5db872' }} />
          </span>
          <span className="caption-uppercase" style={{ fontSize: 10.5 }}>
            {selectedNodeId ? selectedNodeLabel : 'All nodes'}
          </span>
        </span>
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
