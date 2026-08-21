/**
 * Gantt Chart component.
 * Visually proves that independent branches ran in parallel by rendering
 * node durations on a common timeline based on startedAt/finishedAt.
 */

import type { NodeRunSummary } from '../api/client';

export function GanttChart({ nodeRuns }: { nodeRuns: NodeRunSummary[] }) {
  if (!nodeRuns.length) return null;

  const validRuns = nodeRuns.filter(nr => nr.startedAt);
  if (!validRuns.length) return <div style={{ color: '#64748b', fontSize: 12 }}>No timing data available yet.</div>;

  const minTime = Math.min(...validRuns.map(nr => new Date(nr.startedAt!).getTime()));
  // If run is still running, use Date.now() as upper bound for currently running nodes
  const maxTime = Math.max(
    ...validRuns.map(nr => nr.finishedAt ? new Date(nr.finishedAt).getTime() : Date.now())
  );
  
  const durationMs = Math.max(maxTime - minTime, 1000); // at least 1s

  return (
    <div style={{ marginTop: 12, padding: 8, background: '#020617', borderRadius: 6 }}>
      {validRuns.map(nr => {
        const start = new Date(nr.startedAt!).getTime();
        const end = nr.finishedAt ? new Date(nr.finishedAt).getTime() : Date.now();
        const leftPercent = ((start - minTime) / durationMs) * 100;
        const widthPercent = Math.max(((end - start) / durationMs) * 100, 1); // min 1% width

        let color = '#3b82f6'; // RUNNING
        if (nr.status === 'SUCCEEDED') color = '#22c55e';
        else if (nr.status === 'FAILED') color = '#ef4444';
        else if (nr.status === 'CANCELLED') color = '#6b7280';

        return (
          <div key={nr.nodeKey} style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
            <div style={{ width: 100, fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {nr.nodeKey}
            </div>
            <div style={{ flex: 1, position: 'relative', height: 16, background: '#1e293b', borderRadius: 4 }}>
              <div style={{
                position: 'absolute',
                left: `${leftPercent}%`,
                width: `${widthPercent}%`,
                height: '100%',
                background: color,
                borderRadius: 4,
                opacity: 0.8
              }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
