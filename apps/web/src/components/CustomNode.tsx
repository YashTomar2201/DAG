/**
 * Custom React Flow node component.
 * Renders distinct icon, colour, and a live status ring per node type.
 */

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { useRunStore } from '../store/runSlice';
import { useGraphStore, type NodeData } from '../store/graphSlice';
import type { CSSProperties } from 'react';

// ─── Node type metadata ───────────────────────────────────────────────────────

const NODE_META: Record<string, { icon: string; color: string; label: string }> = {
  'kaggle.download':    { icon: '📥', color: '#4f46e5', label: 'Kaggle Download' },
  'pandas.preprocess':  { icon: '🐼', color: '#0891b2', label: 'Preprocess' },
  'torch.train':        { icon: '🔥', color: '#ea580c', label: 'Train' },
  'model.evaluate':     { icon: '📊', color: '#16a34a', label: 'Evaluate' },
  'registry.deploy':    { icon: '🚀', color: '#7c3aed', label: 'Deploy' },
};

const STATUS_RING: Record<string, string> = {
  PENDING:   'transparent',
  QUEUED:    '#a78bfa',
  RUNNING:   '#facc15',
  SUCCEEDED: '#4ade80',
  FAILED:    '#f87171',
  SKIPPED:   '#94a3b8',
  CANCELLED: '#6b7280',
};

const STATUS_PULSE: Record<string, boolean> = {
  RUNNING: true,
  QUEUED: true,
};

export function CustomNode({ id, data, selected }: NodeProps<Node<NodeData>>) {
  const nodeStatus = useRunStore((s) => s.nodeStatuses[id]);
  const cycleHighlight = useGraphStore((s) => s.cycleHighlight);
  const selectNode = useGraphStore((s) => s.selectNode);

  const meta = NODE_META[String(data.nodeType)] ?? { icon: '⚙️', color: '#64748b', label: String(data.nodeType) };
  const status = String(nodeStatus?.status ?? data.status ?? 'PENDING');
  const ringColor = STATUS_RING[status] ?? 'transparent';
  const isPulsing = STATUS_PULSE[status] ?? false;
  const isCycleNode = cycleHighlight.includes(id);

  const nodeStyle: CSSProperties = {
    background: '#1e293b',
    border: `2px solid ${isCycleNode ? '#ef4444' : selected ? meta.color : '#334155'}`,
    borderRadius: 12,
    padding: '10px 16px',
    minWidth: 160,
    cursor: 'pointer',
    boxShadow: selected
      ? `0 0 0 3px ${meta.color}44`
      : isCycleNode
      ? '0 0 12px #ef4444aa'
      : '0 2px 8px #0004',
    transition: 'box-shadow 0.2s, border-color 0.2s',
    position: 'relative',
  };

  return (
    <div style={nodeStyle} onClick={() => selectNode(id)}>
      {/* Status ring */}
      <div style={{
        position: 'absolute',
        top: -5,
        right: -5,
        width: 14,
        height: 14,
        borderRadius: '50%',
        background: ringColor,
        border: '2px solid #1e293b',
        animation: isPulsing ? 'pulse 1.2s ease-in-out infinite' : 'none',
      }} />

      <Handle type="target" position={Position.Left} style={{ background: '#64748b' }} />

      {/* Icon + type badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 20 }}>{meta.icon}</span>
        <span style={{
          fontSize: 10,
          background: meta.color + '33',
          color: meta.color,
          borderRadius: 4,
          padding: '1px 6px',
          fontFamily: 'monospace',
          fontWeight: 600,
        }}>
          {String(data.nodeType)}
        </span>
      </div>

      {/* Label */}
      <div style={{ color: '#f1f5f9', fontWeight: 600, fontSize: 13 }}>{String(data.label)}</div>

      {/* Status badge */}
      {status !== 'PENDING' && (
        <div style={{
          marginTop: 4,
          fontSize: 10,
          color: ringColor,
          fontFamily: 'monospace',
          fontWeight: 600,
          letterSpacing: '0.05em',
        }}>
          {status}
          {nodeStatus?.attempt && nodeStatus.attempt > 1 ? ` (attempt ${nodeStatus.attempt})` : ''}
        </div>
      )}

      {/* Error indicator */}
      {status === 'FAILED' && !!nodeStatus?.error && (
        <div style={{
          marginTop: 4,
          fontSize: 10,
          color: '#fca5a5',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: 140,
        }}>
          {String(nodeStatus.error).slice(0, 60)}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: '#64748b' }} />
    </div>
  );
}
