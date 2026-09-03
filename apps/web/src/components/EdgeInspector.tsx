/**
 * Edge Inspector — the config panel's edge mode (B1.2).
 *
 * Shown when an edge is selected and no node is (the two are mutually exclusive
 * in the store). Lets you attach a structured `{ left, op, right }` condition to
 * the edge without touching JSON, remove it, or delete the edge outright.
 */

import { useGraphStore, type DagEdgeData } from '../store/graphSlice';
import { OP_OPTIONS } from '../lib/condition';
import type { Condition, ConditionOp } from '@dag/contracts';
import { IconClose, IconTrash } from './icons';

export function EdgeInspector() {
  const selectedEdgeId = useGraphStore((s) => s.selectedEdgeId);
  const edges = useGraphStore((s) => s.edges);
  const nodes = useGraphStore((s) => s.nodes);
  const updateEdgeCondition = useGraphStore((s) => s.updateEdgeCondition);
  const removeEdge = useGraphStore((s) => s.removeEdge);
  const selectEdge = useGraphStore((s) => s.selectEdge);
  const isReadOnly = useGraphStore((s) => s.isReadOnly);

  const edge = edges.find((e) => e.id === selectedEdgeId);
  if (!edge) return null;

  const labelFor = (nodeId: string) =>
    nodes.find((n) => n.id === nodeId)?.data.label ?? nodeId;

  const condition = (edge.data as DagEdgeData | undefined)?.condition;

  function setCondition(patch: Partial<Condition>) {
    const base: Condition = condition ?? {
      left: `{{ nodes.${edge!.source}.output.accuracy }}`,
      op: 'gt',
      right: '0.9',
    };
    updateEdgeCondition(edge!.id, { ...base, ...patch });
  }

  return (
    <aside
      className="animate-in"
      style={{
        width: 300,
        flexShrink: 0,
        background: 'var(--color-surface-dark)',
        color: 'var(--color-on-dark)',
        borderLeft: '1px solid var(--color-surface-dark-soft)',
        padding: '20px 22px 24px',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="caption-uppercase" style={{ color: 'var(--color-on-dark-soft)', fontSize: 11 }}>
          Edge condition
        </span>
        <button
          className="btn-ghost"
          style={{ color: 'var(--color-on-dark-soft)' }}
          onClick={() => selectEdge(null)}
          aria-label="Close panel"
        >
          <IconClose size={15} />
        </button>
      </div>

      {/* source → target */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, fontWeight: 600 }}>
        <span>{labelFor(edge.source)}</span>
        <span style={{ color: 'var(--color-primary)' }}>→</span>
        <span>{labelFor(edge.target)}</span>
      </div>

      <div style={{ borderTop: '1px solid var(--color-surface-dark-soft)' }} />

      {!condition ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p className="body-sm" style={{ color: 'var(--color-on-dark-soft)', opacity: 0.8, lineHeight: 1.6, margin: 0 }}>
            This edge always activates when its source node succeeds. Add a
            condition to gate it on runtime data — the target is skipped when no
            incoming edge is active.
          </p>
          {!isReadOnly && (
            <button className="btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => setCondition({})}>
              Add condition
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="caption" style={{ color: 'var(--color-on-dark-soft)' }}>Left (value or template ref)</label>
            <input
              value={condition.left}
              placeholder="{{ nodes.evaluate.output.accuracy }}"
              onChange={(e) => setCondition({ left: e.target.value })}
              className="input-dark"
              disabled={isReadOnly}
              spellCheck={false}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="caption" style={{ color: 'var(--color-on-dark-soft)' }}>Operator</label>
            <select
              value={condition.op}
              onChange={(e) => setCondition({ op: e.target.value as ConditionOp })}
              className="input-dark"
              disabled={isReadOnly}
            >
              {OP_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="caption" style={{ color: 'var(--color-on-dark-soft)' }}>
              Right {condition.op === 'in' ? '(comma-separated list)' : '(literal)'}
            </label>
            <input
              value={Array.isArray(condition.right) ? condition.right.join(', ') : String(condition.right ?? '')}
              placeholder={condition.op === 'in' ? 'a, b, c' : '0.9'}
              onChange={(e) => setCondition({ right: e.target.value })}
              className="input-dark"
              disabled={isReadOnly}
              spellCheck={false}
            />
          </div>

          <p className="body-sm" style={{ color: 'var(--color-on-dark-soft)', opacity: 0.55, fontSize: 12, margin: 0, lineHeight: 1.5 }}>
            Numbers and <code>true</code>/<code>false</code> are coerced on save.
            An unresolvable <code>left</code> fails the run — it never silently
            skips the branch.
          </p>

          {!isReadOnly && (
            <button
              className="btn-ghost"
              style={{ alignSelf: 'flex-start', color: 'var(--color-on-dark-soft)', fontSize: 12, fontWeight: 600 }}
              onClick={() => updateEdgeCondition(edge.id, null)}
            >
              Remove condition
            </button>
          )}
        </div>
      )}

      <div className="body-sm" style={{ color: 'var(--color-on-dark-soft)', opacity: 0.55, marginTop: 'auto', fontSize: 12 }}>
        {isReadOnly
          ? 'This is a historical version — read-only. Restore it from the banner to edit.'
          : <>Edits apply to the canvas as you type. Hit <strong>Save Changes</strong> in the header to store a new version.</>}
      </div>

      {!isReadOnly && (
        <button
          onClick={() => removeEdge(edge.id)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            background: 'transparent',
            border: '1px solid color-mix(in srgb, var(--color-error) 55%, transparent)',
            color: 'var(--color-error)',
            borderRadius: 'var(--radius-md)',
            padding: '9px 16px',
            cursor: 'pointer',
            fontSize: 13,
            fontFamily: 'var(--font-body)',
            fontWeight: 500,
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'color-mix(in srgb, var(--color-error) 14%, transparent)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
        >
          <IconTrash size={15} />
          Delete edge
        </button>
      )}
    </aside>
  );
}
