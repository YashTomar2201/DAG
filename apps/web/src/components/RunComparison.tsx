/**
 * Run comparison overlay (roadmap D3).
 *
 * Two runs of the same workflow side by side on one shared time axis, so a
 * regression jumps out: the right-hand chart annotates every node with how
 * much faster or slower it was than the left-hand ("baseline") run.
 *
 * Opened from RunHistory once the user has picked a baseline run and then a
 * second one to compare it against.
 */

import type { RunSummary } from '../api/client';
import { GanttChart, nodeDurations, nodeDurationMs } from './GanttChart';
import { IconClose, IconCompare } from './icons';

const STATUS_COLOR: Record<string, string> = {
  SUCCEEDED: 'var(--color-success)',
  FAILED: 'var(--color-error)',
  RUNNING: 'var(--color-warning)',
  CANCELLED: 'var(--color-muted-soft)',
};

/** Wall-clock span of a run: its own start→finish, else the envelope of its node runs. */
function runSpanMs(run: RunSummary): number {
  if (run.startedAt && run.finishedAt) {
    return Math.max(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime(), 0);
  }
  const starts = run.nodeRuns.map(nr => nr.startedAt).filter(Boolean).map(s => new Date(s!).getTime());
  if (!starts.length) return 0;
  const ends = run.nodeRuns.map(nr =>
    nr.finishedAt ? new Date(nr.finishedAt).getTime() : Date.now(),
  );
  return Math.max(Math.max(...ends) - Math.min(...starts), 0);
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function fmtTime(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function Column({
  run,
  label,
  scaleMaxMs,
  nodeLabels,
  compareDurations,
}: {
  run: RunSummary;
  label: string;
  scaleMaxMs: number;
  nodeLabels: Record<string, string>;
  compareDurations?: Record<string, number>;
}) {
  const span = runSpanMs(run);
  const hasTiming = run.nodeRuns.some(nr => nodeDurationMs(nr) != null);
  return (
    <div style={{ flex: 1, minWidth: 320 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 2 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-ink)' }}>{label}</span>
        <span style={{
          fontSize: 11, fontWeight: 600, letterSpacing: '0.03em',
          color: STATUS_COLOR[run.status] ?? 'var(--color-muted)',
        }}>
          {run.status}
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 8 }}>
        {fmtTime(run.startedAt)} · <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtDuration(span)}</span> total
      </div>
      {hasTiming ? (
        <GanttChart
          nodeRuns={run.nodeRuns}
          nodeLabels={nodeLabels}
          scaleMaxMs={scaleMaxMs}
          compareDurations={compareDurations}
        />
      ) : (
        <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: '16px 8px' }}>
          No timing data for this run.
        </div>
      )}
    </div>
  );
}

export function RunComparison({
  runA,
  runB,
  labelA,
  labelB,
  nodeLabels,
  onClose,
}: {
  runA: RunSummary;
  runB: RunSummary;
  labelA: string;
  labelB: string;
  nodeLabels: Record<string, string>;
  onClose: () => void;
}) {
  const spanA = runSpanMs(runA);
  const spanB = runSpanMs(runB);
  const scaleMaxMs = Math.max(spanA, spanB, 1000);
  const totalDelta = spanB - spanA;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(20,20,19,0.28)',
        zIndex: 40,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 64,
      }}
    >
      <div
        className="animate-in"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(920px, calc(100% - 48px))',
          maxHeight: 'calc(100% - 96px)',
          background: 'var(--color-canvas)',
          border: '1px solid var(--color-hairline)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 20px 56px rgba(20,20,19,0.24)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px 14px 20px', borderBottom: '1px solid var(--color-hairline)',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--color-ink)', fontWeight: 600, fontSize: 15 }}>
            <IconCompare size={16} />
            Compare runs
          </span>
          <button className="btn-ghost" onClick={onClose} aria-label="Close">
            <IconClose size={15} />
          </button>
        </div>

        <div style={{
          padding: '10px 20px', borderBottom: '1px solid var(--color-hairline)',
          fontSize: 12, color: 'var(--color-muted)',
        }}>
          Wall-clock:{' '}
          <span style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>{fmtDuration(spanA)}</span>
          {' → '}
          <span style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>{fmtDuration(spanB)}</span>
          {Math.abs(totalDelta) >= 250 && (
            <span style={{
              marginLeft: 8, fontWeight: 600,
              color: totalDelta > 0 ? 'var(--color-error)' : 'var(--color-success)',
            }}>
              {totalDelta > 0 ? '+' : '−'}{fmtDuration(Math.abs(totalDelta))} {totalDelta > 0 ? 'slower' : 'faster'}
            </span>
          )}
          <span style={{ float: 'right' }}>right column: Δ vs left, per node</span>
        </div>

        <div style={{ padding: 20, overflowY: 'auto', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <Column run={runA} label={labelA} scaleMaxMs={scaleMaxMs} nodeLabels={nodeLabels} />
          <Column
            run={runB}
            label={labelB}
            scaleMaxMs={scaleMaxMs}
            nodeLabels={nodeLabels}
            compareDurations={nodeDurations(runA.nodeRuns)}
          />
        </div>
      </div>
    </div>
  );
}
