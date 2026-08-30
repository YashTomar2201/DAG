/**
 * Node Palette — drag source for adding new nodes to the canvas.
 * Each palette item can be dragged and dropped onto the React Flow canvas.
 */

const PALETTE_ITEMS = [
  { type: 'kaggle.download',   label: 'Kaggle Download', icon: '📥', color: 'var(--color-accent-teal)' },
  { type: 'pandas.preprocess', label: 'Preprocess',      icon: '🐼', color: 'var(--color-primary)' },
  { type: 'torch.train',       label: 'Train',           icon: '🔥', color: 'var(--color-accent-amber)' },
  { type: 'model.evaluate',    label: 'Evaluate',        icon: '📊', color: 'var(--color-success)' },
  { type: 'registry.deploy',   label: 'Deploy',          icon: '🚀', color: 'var(--color-primary-active)' },
];

export function NodePalette() {
  function onDragStart(e: React.DragEvent, type: string, label: string) {
    e.dataTransfer.setData('application/dag-node-type', type);
    e.dataTransfer.setData('application/dag-node-label', label);
    e.dataTransfer.effectAllowed = 'move';
  }

  return (
    <aside style={{
      width: 240,
      background: 'var(--color-canvas)',
      borderRight: '1px solid var(--color-hairline)',
      padding: '24px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      overflowY: 'auto',
    }}>
      <div className="caption-uppercase" style={{ color: 'var(--color-muted)', marginBottom: 16, textAlign: 'center' }}>
        Node Palette
      </div>
      {PALETTE_ITEMS.map((item) => (
        <div
          key={item.type}
          draggable
          onDragStart={(e) => onDragStart(e, item.type, item.label)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '16px',
            background: 'var(--color-surface-card)',
            border: '1px solid var(--color-hairline)',
            borderRadius: 'var(--radius-lg)',
            cursor: 'grab',
            color: 'var(--color-ink)',
            transition: 'transform 0.1s, background-color 0.15s',
            userSelect: 'none',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-cream-strong)';
            (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-card)';
            (e.currentTarget as HTMLElement).style.transform = 'translateY(0)';
          }}
        >
          <span style={{ fontSize: 20 }}>{item.icon}</span>
          <div>
            <div className="title-sm" style={{ lineHeight: 1.2 }}>{item.label}</div>
            <div className="code" style={{ fontSize: 11, color: 'var(--color-muted)' }}>{item.type}</div>
          </div>
        </div>
      ))}
      <div className="body-sm" style={{ color: 'var(--color-muted-soft)', marginTop: 24, textAlign: 'center', fontStyle: 'italic' }}>
        Drag onto canvas to add a node
      </div>
    </aside>
  );
}
