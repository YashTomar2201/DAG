/**
 * Node Palette — drag source for adding new nodes to the canvas.
 * Each palette item can be dragged and dropped onto the React Flow canvas.
 */

const PALETTE_ITEMS = [
  { type: 'kaggle.download',   label: 'Kaggle Download', icon: '📥', color: '#4f46e5' },
  { type: 'pandas.preprocess', label: 'Preprocess',      icon: '🐼', color: '#0891b2' },
  { type: 'torch.train',       label: 'Train',           icon: '🔥', color: '#ea580c' },
  { type: 'model.evaluate',    label: 'Evaluate',        icon: '📊', color: '#16a34a' },
  { type: 'registry.deploy',   label: 'Deploy',          icon: '🚀', color: '#7c3aed' },
];

export function NodePalette() {
  function onDragStart(e: React.DragEvent, type: string, label: string) {
    e.dataTransfer.setData('application/dag-node-type', type);
    e.dataTransfer.setData('application/dag-node-label', label);
    e.dataTransfer.effectAllowed = 'move';
  }

  return (
    <aside style={{
      width: 180,
      background: '#0f172a',
      borderRight: '1px solid #1e293b',
      padding: '16px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      overflowY: 'auto',
    }}>
      <div style={{ color: '#64748b', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', marginBottom: 8 }}>
        NODE PALETTE
      </div>
      {PALETTE_ITEMS.map((item) => (
        <div
          key={item.type}
          draggable
          onDragStart={(e) => onDragStart(e, item.type, item.label)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            background: '#1e293b',
            border: `1px solid ${item.color}44`,
            borderRadius: 8,
            cursor: 'grab',
            color: '#f1f5f9',
            fontSize: 13,
            fontWeight: 500,
            transition: 'background 0.15s, transform 0.1s',
            userSelect: 'none',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = `${item.color}22`;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = '#1e293b';
          }}
        >
          <span style={{ fontSize: 18 }}>{item.icon}</span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600 }}>{item.label}</div>
            <div style={{ fontSize: 10, color: item.color, fontFamily: 'monospace' }}>{item.type}</div>
          </div>
        </div>
      ))}
      <div style={{ color: '#334155', fontSize: 10, marginTop: 8, lineHeight: 1.5 }}>
        Drag onto canvas to add a node
      </div>
    </aside>
  );
}
