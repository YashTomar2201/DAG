/**
 * Node Palette — drag source for adding new nodes to the canvas.
 * Each palette item can be dragged and dropped onto the React Flow canvas.
 */

import React from 'react';
import { NODE_ICON } from './icons';

const PALETTE_ITEMS = [
  { type: 'data.source',       label: 'Data Source',     accent: 'var(--node-download)' },
  { type: 'pandas.preprocess', label: 'Preprocess',      accent: 'var(--node-preprocess)' },
  { type: 'torch.train',       label: 'Train',           accent: 'var(--node-train)' },
  { type: 'model.evaluate',    label: 'Evaluate',        accent: 'var(--node-evaluate)' },
  { type: 'registry.deploy',   label: 'Deploy',          accent: 'var(--node-deploy)' },
  { type: 'flow.map',          label: 'Fan-out (map)',   accent: 'var(--node-preprocess)' },
];

export function NodePalette() {
  function onDragStart(e: React.DragEvent, type: string, label: string) {
    e.dataTransfer.setData('application/dag-node-type', type);
    e.dataTransfer.setData('application/dag-node-label', label);
    e.dataTransfer.effectAllowed = 'move';
  }

  return (
    <aside
      style={{
        width: 236,
        flexShrink: 0,
        background: 'var(--color-canvas)',
        borderRight: '1px solid var(--color-hairline)',
        padding: '20px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        overflowY: 'auto',
      }}
    >
      <div
        className="caption-uppercase"
        style={{ color: 'var(--color-muted-soft)', margin: '2px 4px 12px', fontSize: 11 }}
      >
        Blocks
      </div>

      {PALETTE_ITEMS.map((item) => {
        const Icon = NODE_ICON[item.type];
        return (
          <div
            key={item.type}
            className="palette-card"
            draggable
            onDragStart={(e) => onDragStart(e, item.type, item.label)}
            style={{ ['--card-accent' as string]: item.accent }}
          >
            <span className="palette-card__icon">{Icon ? <Icon size={18} /> : null}</span>
            <div style={{ minWidth: 0 }}>
              <div className="title-sm" style={{ lineHeight: 1.2, fontSize: 14 }}>
                {item.label}
              </div>
              <div className="code" style={{ fontSize: 11, color: 'var(--color-muted-soft)' }}>
                {item.type}
              </div>
            </div>
          </div>
        );
      })}

      <div
        className="body-sm"
        style={{ color: 'var(--color-muted-soft)', marginTop: 'auto', padding: '16px 4px 4px', fontSize: 12 }}
      >
        Drag a block onto the canvas, then connect the handles to build a pipeline.
      </div>
    </aside>
  );
}
