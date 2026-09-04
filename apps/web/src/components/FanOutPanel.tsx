/**
 * Fan-out panel (roadmap B3.5). Opens when a `flow.map` node is selected — a
 * live count of its child runs plus a drill-in: click a child to see its own
 * node timeline. We never render N child nodes on the canvas; this panel is the
 * window into the fan-out.
 */

import { useCallback, useEffect, useState } from 'react';
import { useGraphStore } from '../store/graphSlice';
import { useRunStore } from '../store/runSlice';
import { getRunChildren, getRun, type ChildRunRow, type RunSummary } from '../api/client';
import { GanttChart } from './GanttChart';
import { IconFanOut, IconClose, IconSpinner } from './icons';

const STATUS_COLOR: Record<string, string> = {
  SUCCEEDED: 'var(--color-success)',
  FAILED: 'var(--color-error)',
  RUNNING: 'var(--color-warning)',
  PENDING: 'var(--color-muted-soft)',
  CANCELLED: 'var(--color-muted-soft)',
};

const PAGE = 50;

export function FanOutPanel() {
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === s.selectedNodeId));
  const nodeLabels = useGraphStore((s) =>
    Object.fromEntries(s.nodes.map((n) => [n.id, n.data.label])),
  );
  const activeRunId = useRunStore((s) => s.activeRunId);
  const progress = useRunStore((s) => (selectedNodeId ? s.fanOut[selectedNodeId] : undefined));

  const [rows, setRows] = useState<ChildRunRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedChild, setSelectedChild] = useState<RunSummary | null>(null);
  const [loadingChildId, setLoadingChildId] = useState<string | null>(null);

  const isFanOutNode = node?.data.nodeType === 'flow.map';

  const load = useCallback(
    async (cursor?: string) => {
      if (!activeRunId) return;
      setLoading(true);
      try {
        const res = await getRunChildren(activeRunId, { limit: PAGE, cursor });
        setRows((prev) => (cursor ? [...prev, ...res.children] : res.children));
        setNextCursor(res.nextCursor);
      } catch {
        /* transient — the Refresh button retries */
      } finally {
        setLoading(false);
      }
    },
    [activeRunId],
  );

  // Reload when the fan-out node / run changes, and as children complete.
  useEffect(() => {
    setRows([]);
    setNextCursor(null);
    setSelectedChild(null);
    if (isFanOutNode && activeRunId) void load();
  }, [isFanOutNode, activeRunId, selectedNodeId, load]);

  useEffect(() => {
    if (isFanOutNode && activeRunId) void load();
    // progress.done climbs as children finish — refetch the first page then.
  }, [progress?.done, isFanOutNode, activeRunId, load]);

  async function openChild(id: string) {
    setLoadingChildId(id);
    try {
      setSelectedChild(await getRun(id));
    } catch {
      /* ignore */
    } finally {
      setLoadingChildId(null);
    }
  }

  if (!isFanOutNode) return null;

  return (
    <div
      className="animate-in"
      style={{
        position: 'absolute',
        top: 20,
        right: 20,
        width: 420,
        maxHeight: 'calc(100% - 40px)',
        background: 'var(--color-canvas)',
        border: '1px solid var(--color-hairline)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: '0 16px 44px rgba(20,20,19,0.16)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 12,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px 14px 20px',
          borderBottom: '1px solid var(--color-hairline)',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--color-ink)', fontWeight: 600, fontSize: 15 }}>
          <IconFanOut size={16} />
          Fan-out · {node?.data.label}
        </span>
        <button className="btn-ghost" onClick={() => useGraphStore.getState().selectNode(null)} aria-label="Close">
          <IconClose size={15} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!activeRunId ? (
          <div className="body-md" style={{ color: 'var(--color-muted)', textAlign: 'center', padding: 32 }}>
            Run the pipeline to see this node's child runs.
          </div>
        ) : (
          <>
            {progress && progress.total > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>
                  <span>{progress.done} / {progress.total} done</span>
                  <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>
                    {progress.succeeded} ok{progress.failed ? ` · ${progress.failed} failed` : ''}
                    {progress.cancelled ? ` · ${progress.cancelled} cancelled` : ''}
                  </span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: 'var(--color-surface-soft)', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.round((progress.done / progress.total) * 100)}%`,
                      background: progress.failed > 0 ? 'var(--color-warning)' : 'var(--color-success)',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="caption-uppercase" style={{ fontSize: 10, letterSpacing: '1.2px', color: 'var(--color-muted-soft)' }}>
                Child runs
              </span>
              <button
                onClick={() => void load()}
                style={{ font: 'inherit', fontSize: 11, background: 'transparent', border: 'none', color: 'var(--color-body)', cursor: 'pointer' }}
              >
                {loading ? <IconSpinner size={12} /> : 'Refresh'}
              </button>
            </div>

            {rows.length === 0 ? (
              <div className="body-sm" style={{ color: 'var(--color-muted)' }}>
                {loading ? 'Loading…' : 'No child runs yet.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rows.map((c) => (
                  <div key={c.id}>
                    <button
                      onClick={() => (selectedChild?.id === c.id ? setSelectedChild(null) : void openChild(c.id))}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        padding: '8px 10px',
                        border: `1px solid ${selectedChild?.id === c.id ? 'var(--color-primary)' : 'var(--color-hairline)'}`,
                        borderRadius: 'var(--radius-md)',
                        background: 'transparent',
                        cursor: loadingChildId === c.id ? 'wait' : 'pointer',
                        font: 'inherit',
                        color: 'var(--color-ink)',
                      }}
                    >
                      <span style={{ fontFamily: 'var(--font-code)', fontSize: 12, color: 'var(--color-muted)' }}>#{c.fanOutIndex ?? '—'}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: STATUS_COLOR[c.status] ?? 'var(--color-muted)' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOR[c.status] ?? 'var(--color-muted)' }} />
                        {c.status}
                      </span>
                    </button>
                    {selectedChild?.id === c.id && (
                      <div style={{ padding: '8px 0 4px' }}>
                        {selectedChild.nodeRuns?.length ? (
                          <GanttChart nodeRuns={selectedChild.nodeRuns} nodeLabels={nodeLabels} />
                        ) : (
                          <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>No timeline for this child.</div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {nextCursor && (
                  <button
                    onClick={() => void load(nextCursor)}
                    style={{ font: 'inherit', fontSize: 12, marginTop: 4, background: 'transparent', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: '6px 10px', cursor: 'pointer', color: 'var(--color-body)' }}
                  >
                    Load more
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
