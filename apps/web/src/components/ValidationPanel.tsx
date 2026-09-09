/**
 * Live validation panel (roadmap D3). A small badge bottom-left of the canvas
 * that shows the current graph problem count; click to expand the list, ✕ to
 * dismiss it until the issue set changes again.
 */
import { useEffect, useState } from 'react';
import { IconAlert, IconClose } from './icons';

export function ValidationPanel({ issues }: { issues: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const sig = issues.join('|');

  // Re-show whenever the problem set changes.
  useEffect(() => {
    setDismissed(false);
  }, [sig]);

  if (issues.length === 0 || dismissed) return null;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 20,
        left: 20,
        zIndex: 10,
        maxWidth: 340,
        background: 'var(--color-canvas)',
        border: '1px solid var(--color-error)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: '0 10px 30px rgba(20,20,19,0.16)',
        overflow: 'hidden',
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '10px 12px',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          color: 'var(--color-error)',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <IconAlert size={14} />
        {issues.length} issue{issues.length === 1 ? '' : 's'} to fix before saving
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>{expanded ? 'hide' : 'show'}</span>
          <span
            role="button"
            aria-label="Dismiss"
            onClick={(e) => { e.stopPropagation(); setDismissed(true); }}
            style={{ display: 'inline-flex', color: 'var(--color-muted)' }}
          >
            <IconClose size={12} />
          </span>
        </span>
      </button>
      {expanded && (
        <ul style={{ margin: 0, padding: '0 14px 12px 28px', listStyle: 'disc' }}>
          {issues.map((issue, i) => (
            <li key={i} style={{ fontSize: 12, color: 'var(--color-body)', lineHeight: 1.5 }}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
