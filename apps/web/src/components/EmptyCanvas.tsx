/**
 * Empty-canvas template picker (roadmap D3). Shown over the canvas when it has
 * no nodes — instead of a blank grid, offer a few starting points.
 */
import type { Graph } from '@dag/contracts';
import { IconPlay } from './icons';

interface Template {
  name: string;
  blurb: string;
  graph: Graph;
}

function node(key: string, type: string, label: string, x: number, config: Record<string, unknown> = {}): Graph['nodes'][number] {
  return { key, type, label, position: { x, y: 0 }, config } as Graph['nodes'][number];
}

const TEMPLATES: Template[] = [
  {
    name: 'ML pipeline',
    blurb: 'extract → preprocess → train → evaluate — the reference flow.',
    graph: {
      nodes: [
        node('extract', 'data.source', 'Extract', 0),
        node('preprocess', 'pandas.preprocess', 'Preprocess', 240, { scriptPath: 'preprocess.py' }),
        node('train', 'torch.train', 'Train', 480, { scriptPath: 'train.py' }),
        node('evaluate', 'model.evaluate', 'Evaluate', 720, { scriptPath: 'evaluate.py' }),
      ],
      edges: [
        { from: 'extract', to: 'preprocess' },
        { from: 'preprocess', to: 'train' },
        { from: 'train', to: 'evaluate' },
      ],
    } as Graph,
  },
  {
    name: 'Single step',
    blurb: 'Just one data.source node — build out from there.',
    graph: { nodes: [node('source', 'data.source', 'Data source', 0)], edges: [] } as Graph,
  },
  {
    name: 'Fan-out',
    blurb: 'A flow.map that spawns one child run per element, then merges.',
    graph: {
      nodes: [
        node('split', 'data.source', 'Split', 0),
        node('map', 'flow.map', 'Fan out', 240, { overSource: '{{ nodes.split.output.columns }}', subgraph: ['work'], maxFanOut: 50 }),
        node('work', 'data.source', 'Work', 240, {}),
        node('merge', 'data.source', 'Merge', 480),
      ],
      edges: [
        { from: 'split', to: 'map' },
        { from: 'map', to: 'merge' },
      ],
    } as Graph,
  },
];

export function EmptyCanvas({ onPick }: { onPick: (g: Graph) => void }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          background: 'var(--color-canvas)',
          border: '1px solid var(--color-hairline)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: '0 20px 56px rgba(20,20,19,0.16)',
          padding: 24,
          width: 420,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 4 }}>Start from a template</div>
        <div style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 16 }}>
          …or drag a block from the palette to start blank.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {TEMPLATES.map((t) => (
            <button
              key={t.name}
              onClick={() => onPick(t.graph)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                width: '100%',
                padding: '12px 14px',
                border: '1px solid var(--color-hairline)',
                borderRadius: 'var(--radius-lg)',
                background: 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-soft)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <span style={{ color: 'var(--color-primary)', display: 'flex' }}><IconPlay size={14} /></span>
              <span>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--color-ink)' }}>{t.name}</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--color-muted)' }}>{t.blurb}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
