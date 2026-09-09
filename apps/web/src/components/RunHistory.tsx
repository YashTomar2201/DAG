/**
 * Run History Panel.
 * Lists a workflow's past runs and shows a Gantt chart for the selected one.
 *
 * The list is server-backed (roadmap D2): GET /workflows/:id/runs, so a page
 * reload still shows every past run. The Zustand runSlice is layered on top as
 * a live-update cache — the run started in this tab keeps its status fresh over
 * SSE while it's in flight, and brand-new runs appear immediately.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRunStore } from '../store/runSlice';
import { useGraphStore } from '../store/graphSlice';
import { getRun, getWorkflowRuns, retryFailed, type RunSummary, type WorkflowRunRow } from '../api/client';
import { GanttChart } from './GanttChart';
import { RunComparison } from './RunComparison';
import { IconHistory, IconClose, IconRetry, IconCompare } from './icons';

const STATUS_COLOR: Record<string, string> = {
  SUCCEEDED: 'var(--color-success)',
  FAILED: 'var(--color-error)',
  RUNNING: 'var(--color-warning)',
  CANCELLED: 'var(--color-muted-soft)',
};

const STATUS_FILTERS = ['', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
const PAGE_SIZE = 25;

function formatRunTime(ts: string | null | undefined): string {
  if (!ts) return 'Just now';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? 'Just now' : d.toLocaleString();
}

interface DisplayRun {
  id: string;
  workflowVersionId: string;
  status: string;
  startedAt: string | null;
  version?: number;
  nodeCounts?: Record<string, number>;
}

export function RunHistory({ workflowId }: { workflowId: string | null }) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedRun, setSelectedRun] = useState<RunSummary | null>(null);
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null);

  const [fetched, setFetched] = useState<WorkflowRunRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [loadingList, setLoadingList] = useState(false);

  // Run comparison (roadmap D3): pick a baseline row, then a second row.
  const [compareBaseId, setCompareBaseId] = useState<string | null>(null);
  const [comparison, setComparison] = useState<
    { a: RunSummary; b: RunSummary; labelA: string; labelB: string } | null
  >(null);
  const [comparing, setComparing] = useState(false);

  const runs = useRunStore(s => s.runs);
  const upsertRun = useRunStore(s => s.upsertRun);
  const activeRunId = useRunStore(s => s.activeRunId);
  const runStatus = useRunStore(s => s.runStatus);

  const nodeLabels = useGraphStore(s =>
    Object.fromEntries(s.nodes.map(n => [n.id, n.data.label])),
  );
  const versionLabel = useGraphStore(s =>
    Object.fromEntries(s.versions.map(v => [v.id, `v${v.version}`])),
  );

  // ── Fetch the server-backed list on open / workflow change / filter change ──
  const refreshList = () => {
    if (!workflowId) return;
    setLoadingList(true);
    getWorkflowRuns(workflowId, { limit: PAGE_SIZE, status: statusFilter || undefined })
      .then(r => { setFetched(r.runs); setCursor(r.nextCursor); })
      .catch(err => console.error('Failed to load run history:', err))
      .finally(() => setLoadingList(false));
  };

  // refreshList reads workflowId + statusFilter (the deps); getWorkflowRuns is stable.
  useEffect(() => {
    if (isOpen && workflowId) refreshList();
  }, [isOpen, workflowId, statusFilter]);

  const loadMore = async () => {
    if (!workflowId || !cursor) return;
    setLoadingList(true);
    try {
      const r = await getWorkflowRuns(workflowId, {
        limit: PAGE_SIZE,
        cursor,
        status: statusFilter || undefined,
      });
      setFetched(prev => [...prev, ...r.runs]);
      setCursor(r.nextCursor);
    } catch (err) {
      console.error('Failed to load more runs:', err);
    } finally {
      setLoadingList(false);
    }
  };

  // When the active run reaches a terminal state, pull its full detail for the
  // Gantt chart AND refetch the list so the persisted row shows final counts.
  useEffect(() => {
    if (activeRunId && (runStatus === 'SUCCEEDED' || runStatus === 'FAILED' || runStatus === 'CANCELLED')) {
      getRun(activeRunId).then((fullRun) => {
        upsertRun(fullRun as unknown as (typeof runs)[number]);
        setSelectedRun(prev => (prev?.id === activeRunId ? fullRun : prev));
        if (isOpen) refreshList();
      }).catch(console.error);
    }
    // getRun / upsertRun are stable; runStatus + activeRunId are the real triggers.
  }, [runStatus, activeRunId]);

  // ── Merge: server rows + live Zustand overlay ──────────────────────────────
  const displayRuns = useMemo<DisplayRun[]>(() => {
    const map = new Map<string, DisplayRun>();
    for (const r of fetched) {
      map.set(r.id, {
        id: r.id,
        workflowVersionId: r.workflowVersionId,
        status: r.status,
        startedAt: r.startedAt,
        version: r.version,
        nodeCounts: r.nodeCounts,
      });
    }
    for (const r of runs) {
      if (statusFilter && r.status !== statusFilter) {
        map.delete(r.id);
        continue;
      }
      const existing = map.get(r.id);
      map.set(r.id, {
        id: r.id,
        workflowVersionId: r.workflowVersionId,
        status: r.status,
        startedAt: r.startedAt ?? r.createdAt ?? null,
        version: existing?.version,
        nodeCounts: existing?.nodeCounts,
      });
    }
    return [...map.values()].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  }, [fetched, runs, statusFilter]);

  async function handleSelectRun(runId: string) {
    const existing = runs.find(r => r.id === runId) as RunSummary | undefined;
    if (existing && 'nodeRuns' in existing && existing.nodeRuns) {
      setSelectedRun(existing);
      return;
    }
    setLoadingRunId(runId);
    try {
      setSelectedRun(await getRun(runId));
    } catch (e) {
      console.error('Failed to load run detail:', e);
    } finally {
      setLoadingRunId(null);
    }
  }

  function labelForRun(run: DisplayRun): string {
    const v = run.version != null ? `v${run.version}` : versionLabel[run.workflowVersionId];
    return `${v ? `${v} · ` : ''}${formatRunTime(run.startedAt)}`;
  }

  // Baseline picked, second row clicked → pull both full runs and open the overlay.
  async function handleCompareWith(target: DisplayRun) {
    if (!compareBaseId || compareBaseId === target.id) return;
    const base = displayRuns.find(r => r.id === compareBaseId);
    if (!base) { setCompareBaseId(null); return; }
    setComparing(true);
    try {
      const [a, b] = await Promise.all([getRun(compareBaseId), getRun(target.id)]);
      setComparison({ a, b, labelA: labelForRun(base), labelB: labelForRun(target) });
      setCompareBaseId(null);
    } catch (e) {
      console.error('Failed to load runs for comparison:', e);
    } finally {
      setComparing(false);
    }
  }

  const comparisonOverlay = comparison && (
    <RunComparison
      runA={comparison.a}
      runB={comparison.b}
      labelA={comparison.labelA}
      labelB={comparison.labelB}
      nodeLabels={nodeLabels}
      onClose={() => setComparison(null)}
    />
  );

  if (!isOpen) {
    return (
      <>
        <button
          onClick={() => setIsOpen(true)}
          className="btn-secondary"
          style={{
            position: 'absolute',
            top: 20,
            right: 20,
            zIndex: 10,
            fontSize: 13,
            background: 'var(--color-canvas)',
            boxShadow: '0 4px 14px rgba(20,20,19,0.12)',
          }}
        >
          <IconHistory size={15} />
          Run history{runs.length > 0 ? ` · ${runs.length}` : ''}
        </button>
        {comparisonOverlay}
      </>
    );
  }

  return (
    <>
    <div className="animate-in" style={{
      position: 'absolute',
      top: 20,
      right: 20,
      width: 400,
      maxHeight: 'calc(100% - 40px)',
      background: 'var(--color-canvas)',
      border: '1px solid var(--color-hairline)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: '0 16px 44px rgba(20,20,19,0.16)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 10,
      overflow: 'hidden'
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 16px 14px 20px',
        borderBottom: '1px solid var(--color-hairline)',
        background: 'var(--color-canvas)'
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--color-ink)', fontWeight: 600, fontSize: 15 }}>
          <IconHistory size={16} />
          Run history
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter by status"
            style={{
              fontSize: 11,
              padding: '4px 6px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--color-hairline)',
              background: 'var(--color-canvas)',
              color: 'var(--color-ink)',
            }}
          >
            {STATUS_FILTERS.map(s => (
              <option key={s || 'all'} value={s}>{s || 'All statuses'}</option>
            ))}
          </select>
          <button className="btn-ghost" onClick={() => setIsOpen(false)} aria-label="Close">
            <IconClose size={15} />
          </button>
        </div>
      </div>

      {compareBaseId && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '8px 20px', fontSize: 11, color: 'var(--color-ink)',
          background: 'var(--color-surface-card)', borderBottom: '1px solid var(--color-hairline)',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <IconCompare size={13} />
            {comparing ? 'Loading comparison…' : 'Pick another run to compare against'}
          </span>
          <button className="btn-ghost" style={{ fontSize: 11 }} onClick={() => setCompareBaseId(null)}>
            Cancel
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        {!workflowId ? (
          <div className="body-md" style={{ color: 'var(--color-muted)', textAlign: 'center', padding: 32 }}>
            Save the workflow first to see runs.
          </div>
        ) : displayRuns.length === 0 ? (
          <div className="body-md" style={{ color: 'var(--color-muted)', textAlign: 'center', padding: 32 }}>
            {loadingList
              ? 'Loading…'
              : statusFilter
                ? `No ${statusFilter.toLowerCase()} runs.`
                : <>No runs yet. Hit <strong>Run pipeline</strong> to start one.</>}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {displayRuns.map(run => {
              const total = run.nodeCounts?.total ?? 0;
              const succeeded = run.nodeCounts?.SUCCEEDED ?? 0;
              const versionText = run.version != null ? `v${run.version}` : versionLabel[run.workflowVersionId];
              return (
              <div
                key={run.id}
                style={{
                  padding: '16px',
                  background: selectedRun?.id === run.id ? 'var(--color-surface-card)' : 'transparent',
                  border: `1px solid ${selectedRun?.id === run.id ? 'var(--color-primary)' : 'var(--color-hairline)'}`,
                  borderRadius: 'var(--radius-lg)',
                  cursor: loadingRunId === run.id ? 'wait' : 'pointer',
                  transition: 'all 0.2s',
                  opacity: loadingRunId === run.id ? 0.7 : 1,
                }}
                onClick={() => handleSelectRun(run.id)}
                onMouseEnter={(e) => {
                  if (selectedRun?.id !== run.id) {
                    (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-soft)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedRun?.id !== run.id) {
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
                  }
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span className="body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    {formatRunTime(run.startedAt)}
                    {versionText && (
                      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-muted-soft)', letterSpacing: '0.03em' }}>
                        {versionText}
                      </span>
                    )}
                    {total > 0 && (
                      <span style={{ fontSize: 10, color: 'var(--color-muted-soft)' }}>
                        {succeeded}/{total} nodes
                      </span>
                    )}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      className="btn-ghost"
                      aria-label={compareBaseId === run.id ? 'Cancel comparison baseline' : 'Compare this run'}
                      title={
                        compareBaseId == null
                          ? 'Compare with…'
                          : compareBaseId === run.id
                            ? 'Baseline — pick another run'
                            : 'Compare against the baseline'
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        if (compareBaseId == null) setCompareBaseId(run.id);
                        else if (compareBaseId === run.id) setCompareBaseId(null);
                        else handleCompareWith(run);
                      }}
                      style={{
                        padding: 3,
                        color: compareBaseId === run.id ? 'var(--color-primary)' : 'var(--color-muted-soft)',
                        background: compareBaseId === run.id ? 'var(--color-surface-soft)' : 'transparent',
                      }}
                    >
                      <IconCompare size={14} />
                    </button>
                    <span style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: '0.03em',
                      color: STATUS_COLOR[run.status] ?? 'var(--color-muted)',
                    }}>
                      <span style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: STATUS_COLOR[run.status] ?? 'var(--color-muted)',
                        animation: run.id === activeRunId && run.status === 'RUNNING' ? 'pulse 1.2s ease-in-out infinite' : 'none',
                      }} />
                      {run.status}{run.id === activeRunId ? ' · live' : ''}
                    </span>
                  </span>
                </div>

                {selectedRun?.id === run.id && (
                  <div style={{ marginTop: 12, padding: '12px', background: 'var(--color-surface-dark)', borderRadius: 'var(--radius-md)' }}>
                    {'nodeRuns' in selectedRun && selectedRun.nodeRuns ? (
                      <>
                        <GanttChart nodeRuns={selectedRun.nodeRuns} nodeLabels={nodeLabels} />
                        {selectedRun.status === 'FAILED' && (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              await retryFailed(run.id);
                              const updated = await getRun(run.id);
                              setSelectedRun(updated);
                            }}
                            className="btn-primary"
                            style={{ marginTop: 12, width: '100%', fontSize: 12, height: 34 }}
                          >
                            <IconRetry size={14} />
                            Retry failed nodes
                          </button>
                        )}
                      </>
                    ) : (
                      <div style={{ color: 'var(--color-on-dark-soft)', fontSize: 12, textAlign: 'center' }}>
                        {loadingRunId === run.id ? 'Loading…' : 'Click to load details'}
                      </div>
                    )}
                  </div>
                )}
              </div>
              );
            })}

            {cursor && (
              <button
                className="btn-secondary"
                onClick={loadMore}
                disabled={loadingList}
                style={{ fontSize: 12, height: 34 }}
              >
                {loadingList ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
    {comparisonOverlay}
    </>
  );
}
