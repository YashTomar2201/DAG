/**
 * Workflow menu (D1.2) — a header dropdown to list / open / rename / delete
 * saved workflows, plus "New workflow".
 *
 * The list is fetched each time the menu opens (cheap, and always fresh after
 * a save elsewhere). Open/new are guarded against unsaved changes by the
 * caller.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listWorkflows,
  renameWorkflow as apiRename,
  deleteWorkflow as apiDelete,
  type WorkflowListItem,
} from '../api/client';
import { IconClose, IconTrash } from './icons';

interface Props {
  currentWorkflowId: string | null;
  onOpen: (workflowId: string) => void;
  onNew: () => void;
  /** Bumped by the parent after a save so the list refetches next open. */
  refreshKey: number;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return 'never run';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString();
}

export function WorkflowMenu({ currentWorkflowId, onOpen, onNew, refreshKey }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<WorkflowListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { workflows } = await listWorkflows({ limit: 50 });
      setItems(workflows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workflows');
      setItems([]);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load, refreshKey]);

  // Close on outside click / Escape.
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

  async function handleRename(item: WorkflowListItem) {
    const next = window.prompt('Rename workflow', item.name);
    if (next == null || next.trim() === '' || next.trim() === item.name) return;
    setBusyId(item.id);
    try {
      await apiRename(item.id, next.trim());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(item: WorkflowListItem) {
    if (!window.confirm(`Delete "${item.name}"? Its run history stays readable.`)) return;
    setBusyId(item.id);
    try {
      await apiDelete(item.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        className="btn-ghost"
        style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-body)', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6 }}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Workflows
        <span style={{ fontSize: 10, opacity: 0.7 }}>▾</span>
      </button>

      {open && (
        <div
          role="menu"
          className="animate-in"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            left: 0,
            width: 340,
            maxHeight: 420,
            overflowY: 'auto',
            background: 'var(--color-canvas)',
            border: '1px solid var(--color-hairline)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 12px 36px rgba(20,20,19,0.16)',
            zIndex: 200,
            padding: 6,
          }}
        >
          <button
            className="btn-ghost"
            style={{ width: '100%', textAlign: 'left', padding: '9px 10px', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)' }}
            onClick={() => { setOpen(false); onNew(); }}
          >
            + New workflow
          </button>

          <div style={{ borderTop: '1px solid var(--color-hairline)', margin: '4px 0' }} />

          {items === null && (
            <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--color-muted-soft)' }}>Loading…</div>
          )}
          {items?.length === 0 && !error && (
            <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--color-muted-soft)' }}>
              No saved workflows yet. Save the current one to see it here.
            </div>
          )}
          {error && (
            <div style={{ padding: '10px', fontSize: 12, color: 'var(--color-error)' }}>{error}</div>
          )}

          {items?.map((item) => (
            <div
              key={item.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 8px',
                borderRadius: 'var(--radius-md)',
                background: item.id === currentWorkflowId ? 'var(--color-surface)' : 'transparent',
                opacity: busyId === item.id ? 0.5 : 1,
              }}
            >
              <button
                className="btn-ghost"
                style={{ flex: 1, minWidth: 0, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2, padding: '2px 4px' }}
                onClick={() => { setOpen(false); onOpen(item.id); }}
                disabled={busyId === item.id}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.name}
                  {item.id === currentWorkflowId && (
                    <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 500, color: 'var(--color-muted-soft)' }}>open</span>
                  )}
                </span>
                <span style={{ fontSize: 11, color: 'var(--color-muted-soft)' }}>
                  {item.versionCount} version{item.versionCount === 1 ? '' : 's'} · {fmtWhen(item.lastRunAt)}
                </span>
              </button>
              <button
                className="btn-ghost"
                style={{ width: 26, height: 26, color: 'var(--color-body)' }}
                title="Rename"
                onClick={() => handleRename(item)}
                disabled={busyId === item.id}
              >
                ✎
              </button>
              <button
                className="btn-ghost"
                style={{ width: 26, height: 26, color: 'var(--color-error)' }}
                title="Delete"
                onClick={() => handleDelete(item)}
                disabled={busyId === item.id}
              >
                <IconTrash size={14} />
              </button>
            </div>
          ))}

          <div style={{ borderTop: '1px solid var(--color-hairline)', margin: '4px 0 2px' }} />
          <button
            className="btn-ghost"
            style={{ width: '100%', display: 'flex', justifyContent: 'center', gap: 6, padding: '6px', fontSize: 11, color: 'var(--color-muted-soft)' }}
            onClick={() => setOpen(false)}
          >
            <IconClose size={12} /> Close
          </button>
        </div>
      )}
    </div>
  );
}
