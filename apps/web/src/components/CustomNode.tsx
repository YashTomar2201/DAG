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
  'kaggle.download':    { icon: '📥', color: 'var(--color-accent-teal)', label: 'Kaggle Download' },
  'pandas.preprocess':  { icon: '🐼', color: 'var(--color-primary)', label: 'Preprocess' },
  'torch.train':        { icon: '🔥', color: 'var(--color-accent-amber)', label: 'Train' },
  'model.evaluate':     { icon: '📊', color: 'var(--color-success)', label: 'Evaluate' },
  'registry.deploy':    { icon: '🚀', color: 'var(--color-primary-active)', label: 'Deploy' },
};

const STATUS_RING: Record<string, string> = {
  PENDING:   'transparent',
  QUEUED:    'var(--color-muted-soft)',
  RUNNING:   'var(--color-warning)',
  SUCCEEDED: 'var(--color-success)',
  FAILED:    'var(--color-error)',
  SKIPPED:   'var(--color-muted-soft)',
  CANCELLED: 'var(--color-muted-soft)',
};

const STATUS_PULSE: Record<string, boolean> = {
  RUNNING: true,
  QUEUED: true,
};

export function CustomNode({ id, data, selected }: NodeProps<Node<NodeData>>) {
  const nodeStatus = useRunStore((s) => s.nodeStatuses[id]);
  const cycleHighlight = useGraphStore((s) => s.cycleHighlight);
  const selectNode = useGraphStore((s) => s.selectNode);

  const meta = NODE_META[String(data.nodeType)] ?? { icon: '⚙️', color: 'var(--color-muted)', label: String(data.nodeType) };
  const status = String(nodeStatus?.status ?? data.status ?? 'PENDING');
  const ringColor = STATUS_RING[status] ?? 'transparent';
  const isPulsing = STATUS_PULSE[status] ?? false;
  const isCycleNode = cycleHighlight.includes(id);

  const nodeStyle: CSSProperties = {
    background: 'var(--color-surface-dark-elevated)',
    border: `2px solid ${isCycleNode ? 'var(--color-error)' : selected ? meta.color : 'var(--color-surface-dark-soft)'}`,
    borderRadius: 'var(--radius-md)',
    padding: '10px 16px',
    minWidth: 160,
    cursor: 'pointer',
    boxShadow: selected
      ? `0 0 0 2px var(--color-surface-dark-elevated), 0 0 0 4px ${meta.color}`
      : isCycleNode
      ? '0 0 0 2px var(--color-surface-dark-elevated), 0 0 0 4px var(--color-error)'
      : '0 2px 8px rgba(0,0,0,0.4)',
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
        border: '2px solid var(--color-surface-dark-elevated)',
        animation: isPulsing ? 'pulse 1.2s ease-in-out infinite' : 'none',
      }} />

      <Handle type="target" position={Position.Left} style={{ background: 'var(--color-muted-soft)' }} />

      {/* Icon + type badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 20 }}>{meta.icon}</span>
        <span style={{
          fontSize: 10,
          border: `1px solid ${meta.color}`,
          color: meta.color,
          borderRadius: 'var(--radius-xs)',
          padding: '2px 6px',
          fontFamily: 'var(--font-code)',
          fontWeight: 600,
        }}>
          {String(data.nodeType)}
        </span>
      </div>

      {/* Label */}
      <div style={{ color: 'var(--color-on-dark)', fontWeight: 600, fontSize: 13 }}>{String(data.label)}</div>

      {/* Status badge */}
      {status !== 'PENDING' && (
        <div style={{
          marginTop: 4,
          fontSize: 10,
          color: ringColor,
          fontFamily: 'var(--font-code)',
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
          color: 'var(--color-error)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: 140,
        }}>
          {String(nodeStatus.error).slice(0, 60)}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: 'var(--color-muted-soft)' }} />
    </div>
  );
}
