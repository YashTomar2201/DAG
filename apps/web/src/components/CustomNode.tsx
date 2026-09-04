/**
 * Custom React Flow node component.
 * Renders a per-type line icon, accent colour, and a live status ring.
 * On hover (or when selected) a small delete control appears at the corner.
 */

import { useState } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { useRunStore } from '../store/runSlice';
import { useGraphStore, type NodeData } from '../store/graphSlice';
import { NODE_ICON, IconNode, IconClose } from './icons';

// ─── Node type metadata ───────────────────────────────────────────────────────

const NODE_ACCENT: Record<string, string> = {
  'data.source': 'var(--node-download)',
  'pandas.preprocess': 'var(--node-preprocess)',
  'torch.train': 'var(--node-train)',
  'model.evaluate': 'var(--node-evaluate)',
  'registry.deploy': 'var(--node-deploy)',
};

const STATUS_RING: Record<string, string> = {
  PENDING: 'transparent',
  QUEUED: 'var(--color-muted-soft)',
  RUNNING: 'var(--color-warning)',
  SUCCEEDED: 'var(--color-success)',
  FAILED: 'var(--color-error)',
  SKIPPED: 'var(--color-muted-soft)',
  CANCELLED: 'var(--color-muted-soft)',
};

const STATUS_PULSE: Record<string, boolean> = { RUNNING: true, QUEUED: true };

export function CustomNode({ id, data, selected }: NodeProps<Node<NodeData>>) {
  const nodeStatus = useRunStore((s) => s.nodeStatuses[id]);
  const fanOut = useRunStore((s) => s.fanOut[id]);
  const cycleHighlight = useGraphStore((s) => s.cycleHighlight);
  const selectNode = useGraphStore((s) => s.selectNode);
  const removeNode = useGraphStore((s) => s.removeNode);

  const [hovered, setHovered] = useState(false);

  const nodeType = String(data.nodeType);
  const Icon = NODE_ICON[nodeType] ?? IconNode;
  const accent = NODE_ACCENT[nodeType] ?? 'var(--color-muted)';
  const status = String(nodeStatus?.status ?? data.status ?? 'PENDING');
  const ringColor = STATUS_RING[status] ?? 'transparent';
  const isPulsing = STATUS_PULSE[status] ?? false;
  const isCycleNode = cycleHighlight.includes(id);

  const borderColor = isCycleNode
    ? 'var(--color-error)'
    : selected
    ? accent
    : 'var(--color-surface-dark-soft)';

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    removeNode(id);
  }

  return (
    <div
      className="dag-node"
      style={{
        ['--node-accent' as string]: accent,
        borderColor,
        boxShadow: selected || isCycleNode
          ? `0 0 0 3px color-mix(in srgb, ${isCycleNode ? 'var(--color-error)' : accent} 30%, transparent), 0 8px 22px rgba(0,0,0,0.45)`
          : undefined,
      }}
      onClick={() => selectNode(id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Status ring */}
      <div
        style={{
          position: 'absolute',
          top: -5,
          right: -5,
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: ringColor,
          border: '2px solid var(--color-surface-dark-elevated)',
          animation: isPulsing ? 'pulse 1.2s ease-in-out infinite' : 'none',
        }}
      />

      {(hovered || selected) && (
        <button className="dag-node__del" onClick={handleDelete} title="Delete node" aria-label="Delete node">
          <IconClose size={11} />
        </button>
      )}

      <Handle type="target" position={Position.Left} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="dag-node__icon">
          <Icon size={17} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              color: 'var(--color-on-dark)',
              fontWeight: 600,
              fontSize: 13,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {String(data.label)}
          </div>
          <div
            className="code"
            style={{ fontSize: 10, color: 'var(--color-on-dark-soft)', opacity: 0.7, lineHeight: 1.4 }}
          >
            {nodeType}
          </div>
        </div>
      </div>

      {/* Status badge */}
      {status !== 'PENDING' && (
        <div
          style={{
            marginTop: 8,
            fontSize: 10,
            color: ringColor,
            fontFamily: 'var(--font-code)',
            fontWeight: 600,
            letterSpacing: '0.06em',
          }}
        >
          {status}
          {nodeStatus?.attempt && nodeStatus.attempt > 1 ? `  ·  attempt ${nodeStatus.attempt}` : ''}
        </div>
      )}

      {status === 'FAILED' && !!nodeStatus?.error && (
        <div
          style={{
            marginTop: 4,
            fontSize: 10,
            color: 'var(--color-error)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 150,
          }}
        >
          {String(nodeStatus.error).slice(0, 60)}
        </div>
      )}

      {/* Fan-out progress pill (B3.5) — one node, live "done / total", not N nodes */}
      {nodeType === 'flow.map' && fanOut && fanOut.total > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 10, fontFamily: 'var(--font-code)', fontWeight: 600, color: 'var(--color-on-dark)' }}>
              {fanOut.done} / {fanOut.total}
            </span>
            {fanOut.failed > 0 && (
              <span style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--color-error)' }}>
                {fanOut.failed} failed
              </span>
            )}
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--color-surface-dark-elevated)', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${Math.round((fanOut.done / fanOut.total) * 100)}%`,
                background: fanOut.failed > 0 ? 'var(--color-warning)' : 'var(--color-success)',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
