/**
 * Gantt Chart component.
 * Visually proves that independent branches ran in parallel by rendering
 * node durations on a common timeline based on startedAt/finishedAt.
 *
 * Run comparison (roadmap D3): pass `scaleMaxMs` so two charts of different
 * runs share one time axis (a node that took twice as long looks twice as
 * wide across both), and `compareDurations` (nodeKey → ms from the *other*
 * run) to annotate each bar with how much faster / slower it was.
 */

import type { NodeRunSummary } from '../api/client';

/** Wall-clock ms a node was active, or null if it never started. */
export function nodeDurationMs(nr: NodeRunSummary): number | null {
  if (!nr.startedAt) return null;
  const start = new Date(nr.startedAt).getTime();
  const end = nr.finishedAt ? new Date(nr.finishedAt).getTime() : Date.now();
  return Math.max(end - start, 0);
}

/** Map of nodeKey → active duration (ms) for every node that has timing. */
export function nodeDurations(nodeRuns: NodeRunSummary[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const nr of nodeRuns) {
    const d = nodeDurationMs(nr);
    if (d != null) out[nr.nodeKey] = d;
  }
  return out;
}

function formatDelta(ms: number): string {
  const s = ms / 1000;
  const sign = s > 0 ? '+' : '−';
  const abs = Math.abs(s);
  return `${sign}${abs >= 10 ? abs.toFixed(0) : abs.toFixed(1)}s`;
}

export function GanttChart({
  nodeRuns,
  nodeLabels = {},
  scaleMaxMs,
  compareDurations,
}: {
  nodeRuns: NodeRunSummary[];
  nodeLabels?: Record<string, string>;
  scaleMaxMs?: number;
  compareDurations?: Record<string, number>;
}) {
  if (!nodeRuns.length) return null;

  const validRuns = nodeRuns.filter(nr => nr.startedAt);
  if (!validRuns.length) return <div style={{ color: '#64748b', fontSize: 12 }}>No timing data available yet.</div>;

  const minTime = Math.min(...validRuns.map(nr => new Date(nr.startedAt!).getTime()));
  // If run is still running, use Date.now() as upper bound for currently running nodes
  const maxTime = Math.max(
    ...validRuns.map(nr => nr.finishedAt ? new Date(nr.finishedAt).getTime() : Date.now())
  );

  // A caller-supplied axis (run comparison) wins so both charts line up; else
  // fall back to this run's own span. Floor at 1s so a sub-second run still draws.
  const durationMs = Math.max(scaleMaxMs ?? maxTime - minTime, 1000);

  return (
    <div style={{ marginTop: 12, padding: 8, background: 'var(--color-surface-dark)', borderRadius: 'var(--radius-md)' }}>
      {validRuns.map(nr => {
        const start = new Date(nr.startedAt!).getTime();
        const end = nr.finishedAt ? new Date(nr.finishedAt).getTime() : Date.now();
        const leftPercent = ((start - minTime) / durationMs) * 100;
        const widthPercent = Math.max(((end - start) / durationMs) * 100, 1); // min 1% width

        let color = 'var(--color-primary)'; // RUNNING
        if (nr.status === 'SUCCEEDED') color = 'var(--color-success)';
        else if (nr.status === 'FAILED') color = 'var(--color-error)';
        else if (nr.status === 'CANCELLED') color = 'var(--color-muted-soft)';

        // Comparison delta: this bar's duration minus the same node's duration
        // in the other run. Positive = slower here. Only shown when the node
        // exists in both runs.
        const other = compareDurations?.[nr.nodeKey];
        const selfDur = end - start;
        const delta = other != null ? selfDur - other : null;
        const deltaColor =
          delta == null || Math.abs(delta) < 250
            ? 'var(--color-on-dark-soft)'
            : delta > 0
              ? 'var(--color-error)'
              : 'var(--color-success)';

        return (
          <div key={nr.nodeKey} style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
            <div
              title={nodeLabels[nr.nodeKey] ?? nr.nodeKey}
              style={{ width: 100, fontSize: 11, color: 'var(--color-on-dark-soft)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {nodeLabels[nr.nodeKey] ?? nr.nodeKey}
            </div>
            <div style={{ flex: 1, position: 'relative', height: 16, background: 'var(--color-surface-dark-soft)', borderRadius: 'var(--radius-xs)' }}>
              <div style={{
                position: 'absolute',
                left: `${leftPercent}%`,
                width: `${widthPercent}%`,
                height: '100%',
                background: color,
                borderRadius: 'var(--radius-xs)',
                opacity: 0.8
              }} />
            </div>
            {compareDurations && (
              <div style={{ width: 46, textAlign: 'right', fontSize: 10, color: deltaColor, fontVariantNumeric: 'tabular-nums' }}>
                {delta == null ? '—' : Math.abs(delta) < 250 ? '≈' : formatDelta(delta)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
