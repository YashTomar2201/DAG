/**
 * Version menu (D1.3) — a small header dropdown to browse a workflow's
 * immutable version history. Picking an older version loads it read-only; the
 * "Restore" action (in App.tsx's read-only banner) appends it as a new version.
 */
import { useEffect, useRef, useState } from 'react';
import type { VersionMeta } from '../store/graphSlice';

interface Props {
  versions: VersionMeta[]; // newest first
  currentVersionId: string | null;
  onView: (versionId: string) => void;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export function VersionMenu({ versions, currentVersionId, onView }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (versions.length === 0) return null;

  const latestId = versions[0]?.id;
  const current = versions.find((v) => v.id === currentVersionId);
  const label = current ? `v${current.version}` : `v${versions[0]!.version}`;

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        className="btn-ghost"
        style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-body)', padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 5 }}
        onClick={() => setOpen((v) => !v)}
        title="Version history"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label}
        {current && current.id !== latestId && (
          <span style={{ fontSize: 9, fontWeight: 500, color: 'var(--color-warning)' }}>read-only</span>
        )}
        <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>

      {open && (
        <div
          role="menu"
          className="animate-in"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            left: 0,
            width: 260,
            maxHeight: 360,
            overflowY: 'auto',
            background: 'var(--color-canvas)',
            border: '1px solid var(--color-hairline)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 12px 36px rgba(20,20,19,0.16)',
            zIndex: 200,
            padding: 6,
          }}
        >
          {versions.map((v) => {
            const isCurrent = v.id === currentVersionId;
            const isLatest = v.id === latestId;
            return (
              <button
                key={v.id}
                className="btn-ghost"
                style={{
                  width: '100%',
                  textAlign: 'left',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-md)',
                  background: isCurrent ? 'var(--color-surface)' : 'transparent',
                }}
                onClick={() => { setOpen(false); onView(v.id); }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>
                  v{v.version}
                  {isLatest && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 500, color: 'var(--color-primary)' }}>latest</span>}
                  {isCurrent && !isLatest && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 500, color: 'var(--color-warning)' }}>viewing</span>}
                </span>
                <span style={{ fontSize: 11, color: 'var(--color-muted-soft)' }}>{when(v.createdAt)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
