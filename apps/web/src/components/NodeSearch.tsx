/**
 * Ctrl+K node search (roadmap D3). A small centred overlay: type to filter the
 * graph's nodes by label / key / type, ↑/↓ to move, Enter to jump. Picking a
 * node selects it and pans the canvas to it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, type Node } from '@xyflow/react';
import type { NodeData } from '../store/graphSlice';

interface Props {
  nodes: Node<NodeData>[];
  onPick: (id: string) => void;
  onClose: () => void;
}

export function NodeSearch({ nodes, onPick, onClose }: Props) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { setCenter } = useReactFlow();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = nodes.map((n) => ({ id: n.id, label: n.data.label, type: n.data.nodeType, pos: n.position }));
    if (!needle) return rows.slice(0, 50);
    return rows
      .filter((r) => r.label.toLowerCase().includes(needle) || r.id.toLowerCase().includes(needle) || r.type.toLowerCase().includes(needle))
      .slice(0, 50);
  }, [q, nodes]);

  useEffect(() => {
    if (active >= results.length) setActive(0);
  }, [results, active]);

  const pick = (r: { id: string; pos: { x: number; y: number } }) => {
    setCenter(r.pos.x, r.pos.y, { zoom: 1.2, duration: 400 });
    onPick(r.id);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(20,20,19,0.25)',
        zIndex: 30,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 90,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440,
          maxHeight: 420,
          background: 'var(--color-canvas)',
          border: '1px solid var(--color-hairline)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 20px 56px rgba(20,20,19,0.24)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search nodes by name, key, or type…"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
            else if (e.key === 'Enter') {
              const target = results[active] ?? results[0];
              if (target) pick(target);
            }
          }}
          style={{
            border: 'none',
            borderBottom: '1px solid var(--color-hairline)',
            outline: 'none',
            padding: '13px 16px',
            fontSize: 14,
            fontFamily: 'var(--font-body)',
            color: 'var(--color-ink)',
            background: 'transparent',
          }}
        />
        <div style={{ overflowY: 'auto' }}>
          {results.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-muted)', fontSize: 13 }}>No matching nodes.</div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.id}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(r)}
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'baseline',
                  gap: 10,
                  padding: '9px 16px',
                  border: 'none',
                  background: i === active ? 'var(--color-surface-soft)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-ink)' }}>{r.label}</span>
                <span style={{ fontSize: 11, color: 'var(--color-muted-soft)' }}>{r.id}</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--color-muted-soft)', letterSpacing: '0.03em' }}>{r.type}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
