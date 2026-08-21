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
      bottom: 0,
      left: 180,
      right: 260,
      height: 200,
      background: '#020617',
      borderTop: '1px solid #1e293b',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 10,
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '4px 12px',
        borderBottom: '1px solid #1e293b',
        color: '#64748b',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.1em',
      }}>
        <span>LOGS {selectedNodeId ? `— ${selectedNodeId}` : '(all nodes)'}</span>
        <button
          onClick={clearLogs}
          style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 11 }}
        >
          Clear
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px' }}>
        {nodeLogs.map((l, i) => (
          <div key={i} style={{
            fontFamily: 'monospace',
            fontSize: 11,
            color: '#94a3b8',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}>
            <span style={{ color: '#334155', marginRight: 8 }}>
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
